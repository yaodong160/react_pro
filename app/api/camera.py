"""
摄像头 API：抓图、MJPEG 预览、H.264 WebSocket 预览、云台控制、分辨率管理
"""
import os
import json
import struct
import subprocess
import logging
import threading
import time
from flask import Blueprint, request, g
from app.extensions import db, socketio
from app.models.annotation import AnnotationProject, AnnotatedImage
from app.services.hikvision import get_project_camera
from app.utils.response import success, error
from app.utils.jwt_utils import login_required
from app.utils.file_utils import get_project_upload_dir, generate_timestamp_filename, create_thumbnail
from app.utils.mp4_parser import parse_init_segment, is_init_segment, extract_config_from_fragment, read_box_header

camera_bp = Blueprint('camera', __name__, url_prefix='/camera')

logger = logging.getLogger(__name__)

# 活跃的 ffmpeg 流进程，key=project_id
# value: { 'proc': Popen, 'clients': set(sid), 'worker_started': bool, 'stop_flag': bool }
_active_streams = {}
_streams_lock = threading.Lock()

# 缓存的摄像头配置（用于 query_config 快速响应），key=project_id
# value: dict { 'width', 'height', 'codec', 'sps', 'pps', 'room' }
_cached_configs = {}
_configs_lock = threading.Lock()

# ffmpeg stderr 异常关键字（用于自动恢复）
_FFMPEG_ERROR_KEYWORDS = [
    b'Error', b'error', b'corrupt', b'invalid', b'broken pipe',
    b'Connection refused', b'Connection reset', b'timed out',
    b'Input/output error', b'no frame', b'End of file',
]


def _get_project(project_id):
    """获取项目并校验摄像头配置"""
    project = AnnotationProject.query.get(project_id)
    if not project:
        return None, error('项目不存在', code=404)
    return project, None


# ==================== 连通性检查 ====================

@camera_bp.route('/check/<int:project_id>', methods=['GET'])
@login_required
def check_connection(project_id):
    """检查摄像头连通性"""
    project, err = _get_project(project_id)
    if err:
        return err

    cam, cam_err = get_project_camera(project)
    if cam_err:
        return error(cam_err)

    ok = cam._check_connection()
    if ok:
        return success(data={'connected': True}, message='摄像头连接正常')
    else:
        return error('无法连接摄像头，请检查地址和网络', code=503)


# ==================== 截取单帧 ====================

@camera_bp.route('/capture/<int:project_id>', methods=['POST'])
@login_required
def capture_frame(project_id):
    """截取摄像头当前帧并保存到项目图片库"""
    project, err = _get_project(project_id)
    if err:
        return err

    cam, cam_err = get_project_camera(project)
    if cam_err:
        return error(cam_err)

    # 抓取图片
    img_bytes, cap_err = cam.capture()
    if img_bytes is None:
        return error(f'抓图失败: {cap_err}')

    # 保存文件
    upload_dir = get_project_upload_dir(project_id)
    filename = generate_timestamp_filename('jpeg')
    file_path = os.path.join(upload_dir, filename)

    with open(file_path, 'wb') as f:
        f.write(img_bytes)

    file_size = os.path.getsize(file_path)
    file_url = f"/uploads/{project_id}/{filename}"

    # 生成缩略图
    thumbnail_url = create_thumbnail(file_path, project_id)

    # 尝试获取图片尺寸
    from PIL import Image as PILImage
    width, height = None, None
    try:
        with PILImage.open(file_path) as img:
            width, height = img.size
    except Exception:
        pass

    # 写入数据库
    image = AnnotatedImage(
        filename=filename,
        file_path=file_path,
        file_url=file_url,
        file_size=file_size,
        mime_type='image/jpeg',
        width=width,
        height=height,
        thumbnail_url=thumbnail_url,
        project_id=project_id,
        upload_by=g.current_user_id,
    )
    db.session.add(image)
    db.session.commit()

    return success(data={
        'id': image.id,
        'filename': filename,
        'file_url': file_url,
        'thumbnail_url': thumbnail_url,
        'width': width,
        'height': height,
        'file_size': file_size,
    }, message='截取成功')


# ==================== H.264 WebSocket 实时预览 ====================
# 架构：摄像头 RTSP H.264 → ffmpeg -c:v copy（不转码）→ fMP4 片段 → WebSocket 推送 → 前端 MSE 播放

def _start_ffmpeg_stream(rtsp_url, project_id):
    """
    启动 ffmpeg 子进程，将 RTSP H.264 流转为 fMP4 片段输出到 stdout
    返回 subprocess.Popen 对象
    """
    cmd = [
        'ffmpeg',
        '-rtsp_transport', 'tcp',           # TCP 传输更稳定
        '-rtsp_flags', 'prefer_tcp',        # 强制 TCP
        '-i', rtsp_url,
        '-c:v', 'copy',                     # 不重新编码，直接复制 H.264
        '-an',                               # 禁用音频
        '-f', 'mp4',                         # 输出格式 MP4
        '-movflags', 'frag_keyframe+default_base_moof+dash',
                                             # fMP4: 分片 + 完整 init segment (ftyp+moov)
                                             # dash: 确保开头生成完整的 ftyp+moov init segment
        '-reset_timestamps', '1',
        '-flush_packets', '1',               # 立即刷新每个包
        '-loglevel', 'warning',              # 减少 stderr 日志量
        'pipe:1'                             # 输出到 stdout
    ]
    logger.info(f'[Camera] Starting ffmpeg for project {project_id}: rtsp={rtsp_url}')
    logger.debug(f'[Camera] ffmpeg cmd: {" ".join(cmd)}')
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0
    )
    # stderr 由 _stream_worker 中的 _monitor_stderr 线程统一处理
    # 这里不再启动独立的 stderr 日志线程，避免两个线程竞争读取同一个 pipe
    return proc


def _stop_ffmpeg_stream(project_id):
    """停止 ffmpeg 流进程（幂等，可重复调用）"""
    info = None
    with _streams_lock:
        info = _active_streams.get(project_id)
        if info:
            info['stop_flag'] = True  # 通知 worker 停止循环
    if info and info.get('proc'):
        proc = info['proc']
        logger.info(f'[Camera] Stopping ffmpeg for project {project_id}')
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        except Exception:
            proc.kill()
        print(f'[Camera] ffmpeg process for project {project_id} terminated', flush=True)
    # 从活跃列表中移除（worker finally 块也会做，这里确保即使 worker 卡死也能清理）
    with _streams_lock:
        _active_streams.pop(project_id, None)
    # 清除配置缓存
    with _configs_lock:
        _cached_configs.pop(project_id, None)


@camera_bp.route('/h264-preview/<int:project_id>', methods=['GET'])
@login_required
def h264_preview_info(project_id):
    """获取 H.264 预览信息（RTSP URL 等），供前端建立 WebSocket 连接"""
    project, err = _get_project(project_id)
    if err:
        return err

    cam, cam_err = get_project_camera(project)
    if cam_err:
        return error(cam_err)

    rtsp_url = cam.get_rtsp_url(channel=1, subtype=1)  # 子码流
    return success(data={
        'rtsp_url': rtsp_url,
        'ws_endpoint': f'/ws/camera/{project_id}',
    })


# ==================== SocketIO 事件处理 ====================

@socketio.on('connect', namespace='/ws/camera')
def on_camera_connect():
    """客户端连接 WebSocket"""
    print(f'[Camera WS] ===== Client connected ===== sid={request.sid}', flush=True)
    print(f'[Camera WS] transport: {request.environ.get("HTTP_UPGRADE", "polling")}', flush=True)
    # 立即向客户端发送确认，唤醒前端
    socketio.emit('connected', {
        'message': 'Camera WebSocket connected',
        'namespace': '/ws/camera',
        'sid': request.sid,
    }, to=request.sid, namespace='/ws/camera')
    print(f'[Camera WS] connected event sent to sid={request.sid}', flush=True)


@socketio.on('disconnect', namespace='/ws/camera')
def on_camera_disconnect():
    """客户端断开连接"""
    print(f'[Camera WS] Client disconnected: {request.sid}', flush=True)
    # 找出需要停止的 project_id（该 client 是最后一个活跃 client 的）
    to_stop = []
    with _streams_lock:
        for pid, info in list(_active_streams.items()):
            info['clients'].discard(request.sid)
            if not info['clients']:
                info['stop_flag'] = True  # 先标记停止，在锁外再真正杀进程
                to_stop.append(pid)
    # 在锁外停止推流
    for pid in to_stop:
        _stop_ffmpeg_stream(pid)


@socketio.on('start_stream', namespace='/ws/camera')
def on_start_stream(data):
    """
    开始 H.264 流推送
    data: { project_id: int, token: str }
    """
    print(f'[Camera WS] ===== start_stream received =====', flush=True)
    print(f'[Camera WS] raw data: {data}', flush=True)
    print(f'[Camera WS] data type: {type(data).__name__}', flush=True)
    from app.utils.jwt_utils import decode_token
    project_id = data.get('project_id') if isinstance(data, dict) else None
    token = data.get('token', '') if isinstance(data, dict) else ''
    print(f'[Camera WS] project_id={project_id} type={type(project_id).__name__}, token_present={"YES" if token else "NO"}', flush=True)

    if not project_id or not token:
        msg = f'缺少参数: project_id={project_id}, has_token={bool(token)}'
        print(f'[Camera WS] ERROR: {msg}', flush=True)
        socketio.emit('error', {'message': msg}, to=request.sid, namespace='/ws/camera')
        return {'error': msg}

    # 验证 token
    try:
        payload = decode_token(token)
        if payload is None:
            print(f'[Camera WS] ERROR: Token decode returned None (expired or invalid)', flush=True)
            socketio.emit('error', {'message': 'Token 已过期或无效'}, to=request.sid, namespace='/ws/camera')
            return {'error': 'Token 无效'}
        print(f'[Camera WS] Token decoded OK: user_id={payload.get("user_id")}', flush=True)
    except Exception as e:
        print(f'[Camera WS] ERROR: Token decode exception: {type(e).__name__}: {e}', flush=True)
        socketio.emit('error', {'message': f'Token 验证失败: {e}'}, to=request.sid, namespace='/ws/camera')
        return {'error': f'Token 验证失败: {e}'}

    # 获取项目摄像头 — 每次都查 DB 获取最新 RTSP URL（纯字符串拼接，无网络开销）
    project = db.session.get(AnnotationProject, project_id)
    if not project:
        db.session.close()
        print(f'[Camera WS] ERROR: project_id={project_id} not found in DB', flush=True)
        socketio.emit('error', {'message': f'项目 {project_id} 不存在'}, to=request.sid, namespace='/ws/camera')
        return {'error': '项目不存在'}

    print(f'[Camera WS] Found project: name={project.project_name}, camera_url={project.camera_url}', flush=True)

    cam, cam_err = get_project_camera(project)
    if cam_err:
        db.session.close()
        print(f'[Camera WS] ERROR: get_project_camera failed: {cam_err}', flush=True)
        socketio.emit('error', {'message': cam_err}, to=request.sid, namespace='/ws/camera')
        return {'error': cam_err}

    rtsp_url = cam.get_rtsp_url(channel=1, subtype=1)
    db.session.close()  # 立即归还连接
    print(f'[Camera WS] RTSP URL resolved: {rtsp_url}', flush=True)

    room = f'camera_{project_id}'
    print(f'[Camera WS] Joining room: {room}', flush=True)

    # 加入房间
    from flask_socketio import join_room
    join_room(room)

    # 强制终止该 project 的旧 ffmpeg 流（如有），确保每次都用最新配置
    with _streams_lock:
        old_info = _active_streams.pop(project_id, None)
    if old_info and old_info.get('proc'):
        old_proc = old_info['proc']
        print(f'[Camera WS] project={project_id} 已有活跃推流(pid={old_proc.pid}), 关闭旧连接', flush=True)
        try:
            old_proc.kill()
            old_proc.wait(timeout=2)
        except Exception:
            pass
    # 等待旧 worker 线程完全退出（给 gevent 调度机会）
    time.sleep(0.3)

    # 清除摄像头连接池缓存，确保用最新配置重新连接
    from app.services.hikvision import remove_camera
    remove_camera(project.camera_url, project.camera_username)
    print(f'[Camera WS] Camera pool cache cleared for {project.camera_url}', flush=True)

    # 启动新流
    print(f'[Camera WS] Starting new stream for project {project_id}', flush=True)
    try:
        proc = _start_ffmpeg_stream(rtsp_url, project_id)
        with _streams_lock:
            _active_streams[project_id] = {
                'proc': proc,
                'clients': {request.sid},
                'worker_started': False,
                'stop_flag': False,
            }
        print(f'[Camera WS] ffmpeg process started, PID={proc.pid}', flush=True)
    except FileNotFoundError:
        print(f'[Camera WS] ERROR: ffmpeg not found', flush=True)
        socketio.emit('error', {
            'message': '服务器未安装 ffmpeg，请先安装 ffmpeg 并添加到 PATH'
        }, to=request.sid, namespace='/ws/camera')
        return {'error': '服务器未安装 ffmpeg'}
    except Exception as e:
        print(f'[Camera WS] ERROR: ffmpeg start failed: {type(e).__name__}: {e}', flush=True)
        socketio.emit('error', {'message': f'启动流失败: {e}'}, to=request.sid, namespace='/ws/camera')
        return {'error': f'启动流失败: {e}'}

    # 发送初始 fMP4 头（ftyp + moov）
    socketio.emit('stream_info', {
        'codec': 'h264',
        'status': 'streaming'
    }, to=request.sid, namespace='/ws/camera')
    print(f'[Camera WS] stream_info emitted (new stream) to sid={request.sid}', flush=True)

    # 使用 socketio.start_background_task 启动流推送 worker
    def _stream_worker(pid):
        print(f'[Camera WS] _stream_worker started for project {pid}', flush=True)
        proc = None
        with _streams_lock:
            info = _active_streams.get(pid)
            if info:
                info['worker_started'] = True
                proc = info['proc']

        if not proc:
            print(f'[Camera WS] ERROR: _stream_worker proc is None for project {pid}, aborting', flush=True)
            return

        print(f'[Camera WS] _stream_worker reading from ffmpeg stdout (PID={proc.pid})', flush=True)
        byte_count = 0
        chunk_count = 0
        init_segment_buffer = b''     # 累积 init segment 数据
        init_parsed = False           # 是否已解析并推送 config_response
        init_sent = False             # init segment 是否已作为第一个 video_data 推送
        last_sps = None               # 上一次的 SPS base64（用于检测 config_changed）
        fragment_buffer = b''         # 累积 fragment 数据用于 SPS 提取
        config_check_interval = 30    # 每 30 个 fragment 检查一次 SPS 变化
        fragment_since_check = 0      # 自上次检查以来的 fragment 数
        pending_buffer = b''          # 未对齐的残留数据（确保 box 边界发送）
        stderr_error_count = 0        # ffmpeg stderr 异常计数
        stderr_last_check = time.time()

        # ===== 后台监控 ffmpeg stderr（用于 PTZ 操作后自动恢复）=====
        def _monitor_stderr():
            nonlocal stderr_error_count, stderr_last_check
            for line in proc.stderr:
                text = line.decode(errors="ignore").strip()
                if not text:
                    continue
                # 打印日志
                if 'warning' in text.lower() or 'error' in text.lower() or 'invalid' in text.lower():
                    print(f'[ffmpeg-stderr-{pid}] {text}', flush=True)
                # 检测异常关键字
                lower_line = line.lower()
                is_error = any(kw.lower() in lower_line for kw in _FFMPEG_ERROR_KEYWORDS)
                if is_error:
                    stderr_error_count += 1
                    stderr_last_check = time.time()
                    print(f'[ffmpeg-stderr-{pid}] ⚠️ ERROR detected (count={stderr_error_count}): {text}', flush=True)
        stderr_thread = threading.Thread(target=_monitor_stderr, daemon=True)
        stderr_thread.start()

        def _should_stop():
            """检查是否应该停止 worker"""
            with _streams_lock:
                info = _active_streams.get(pid)
                if not info:
                    return True
                return info.get('stop_flag', False)

        def _check_ffmpeg_health():
            """检查 ffmpeg 进程健康状态，返回 True=健康, False=异常"""
            nonlocal stderr_error_count, stderr_last_check
            # 如果近期有大量 stderr 错误，且超过 5 秒没有新错误，则重置计数
            if stderr_error_count > 0 and time.time() - stderr_last_check > 5:
                stderr_error_count = 0
            # 如果 ffmpeg 进程已退出，不健康
            if proc.poll() is not None:
                return False
            # 短时间内 5+ 个错误，不健康
            if stderr_error_count >= 5:
                return False
            return True

        try:
            while not _should_stop():
                # 检查 ffmpeg 健康状态
                if chunk_count > 0 and not _check_ffmpeg_health():
                    exit_code = proc.poll()
                    print(f'[Camera WS] project={pid} ffmpeg unhealthy (exit_code={exit_code}, stderr_errors={stderr_error_count}), restarting stream', flush=True)
                    # 停止旧进程
                    try:
                        proc.kill()
                        proc.wait(timeout=2)
                    except Exception:
                        pass
                    # 重启 ffmpeg
                    try:
                        proc = _start_ffmpeg_stream(rtsp_url, pid)
                        with _streams_lock:
                            info = _active_streams.get(pid)
                            if info:
                                info['proc'] = proc
                    except Exception as e:
                        print(f'[Camera WS] project={pid} ffmpeg restart failed: {e}', flush=True)
                        break
                    # 重置状态，等待新的 init segment
                    init_parsed = False
                    init_sent = False
                    init_segment_buffer = b''
                    pending_buffer = b''
                    fragment_buffer = b''
                    last_sps = None
                    stderr_error_count = 0
                    # 重启 stderr 监控
                    stderr_thread = threading.Thread(target=_monitor_stderr, daemon=True)
                    stderr_thread.start()
                    continue

                chunk = proc.stdout.read(8192)
                if not chunk:
                    exit_code = proc.poll()
                    print(f'[Camera WS] ffmpeg stdout closed for project {pid}, exit_code={exit_code}, chunks={chunk_count}, bytes={byte_count}', flush=True)
                    break
                byte_count += len(chunk)
                chunk_count += 1

                # 前几个 chunk：累积 init segment 数据，用于解析配置
                if not init_parsed:
                    init_segment_buffer += chunk
                    if is_init_segment(init_segment_buffer):
                        config = parse_init_segment(init_segment_buffer)
                        if config.get('width') and config.get('height') and config.get('codec'):
                            init_parsed = True
                            last_sps = config.get('sps', '')
                            print(f'[Camera WS] project={pid} init segment parsed: '
                                  f'width={config["width"]}, height={config["height"]}, '
                                  f'codec={config["codec"]}, '
                                  f'sps_len={len(config.get("sps",""))}, '
                                  f'pps_len={len(config.get("pps",""))}', flush=True)

                            # 缓存配置（供 query_config 快速响应）
                            with _configs_lock:
                                _cached_configs[pid] = {
                                    'width': config['width'],
                                    'height': config['height'],
                                    'codec': config['codec'],
                                    'sps': config.get('sps', ''),
                                    'pps': config.get('pps', ''),
                                    'room': room,
                                }

                            # 推送 config_response 给所有在房间内的客户端
                            socketio.emit('config_response', {
                                'width': config['width'],
                                'height': config['height'],
                                'codec': config['codec'],
                                'sps': config.get('sps', ''),
                                'pps': config.get('pps', ''),
                            }, to=room, namespace='/ws/camera')
                            print(f'[Camera WS] config_response emitted to room={room}', flush=True)

                            # 将完整的 init segment 作为第一个 video_data 推送（不可分割）
                            socketio.emit('video_data', init_segment_buffer, to=room, namespace='/ws/camera')
                            init_sent = True
                            print(f'[Camera WS] project={pid} init segment sent as video_data, size={len(init_segment_buffer)} bytes', flush=True)
                            # init segment 已发送，跳过后续处理，继续读下一 chunk
                            continue
                    elif chunk_count > 50:
                        # 累积了太多数据还没找到 init segment，放弃等待，直接透传
                        init_parsed = True
                        print(f'[Camera WS] project={pid} init segment not found after {chunk_count} chunks, falling back to passthrough mode', flush=True)
                        # 将已累积的数据放入 pending_buffer 走 box 边界发送
                        pending_buffer = init_segment_buffer
                        # 跳过 continue，继续到 box 边界处理逻辑
                    else:
                        # 还没解析到 init segment，且未达到 fallback 阈值，继续累积
                        continue

                # ===== init segment 解析完成后，按 box 边界推送数据 =====
                # 将 chunk 加入 pending_buffer，按 box 边界分割发送
                pending_buffer += chunk

                # 按 box 边界分割 pending_buffer
                while len(pending_buffer) >= 8:
                    try:
                        box_size, box_type, _ = read_box_header(pending_buffer, 0)
                    except (ValueError, struct.error):
                        # 数据不完整，等待更多数据
                        break
                    if box_size < 8:
                        # 无效 box，丢弃
                        pending_buffer = pending_buffer[1:]
                        continue
                    if box_size > len(pending_buffer):
                        # box 不完整，等待更多数据
                        break
                    # 完整的 box 或 fragment（moof+mdat），发送
                    box_data = pending_buffer[:box_size]
                    pending_buffer = pending_buffer[box_size:]

                    # ===== P2: config_changed 检测 =====
                    if box_type == b'moof':
                        fragment_since_check += 1

                    if box_type == b'mdat' and fragment_since_check >= config_check_interval:
                        fragment_since_check = 0
                        # 需要 moof + mdat 一起提取配置
                        combined = fragment_buffer + box_data
                        frag_config = extract_config_from_fragment(combined)
                        if frag_config and frag_config.get('sps'):
                            current_sps = frag_config['sps']
                            if last_sps and current_sps != last_sps:
                                print(f'[Camera WS] project={pid} ⚡ SPS changed detected! '
                                      f'new resolution: {frag_config["width"]}x{frag_config["height"]}', flush=True)

                                # 更新缓存
                                with _configs_lock:
                                    cached = _cached_configs.get(pid, {})
                                    cached['width'] = frag_config['width']
                                    cached['height'] = frag_config['height']
                                    cached['sps'] = current_sps
                                    _cached_configs[pid] = cached

                                # 构建 codec 字符串
                                new_codec = cached.get('codec', 'avc1.42001E')
                                try:
                                    import base64 as b64
                                    sps_bytes = b64.b64decode(current_sps)
                                    if len(sps_bytes) >= 4:
                                        profile_idc = sps_bytes[1]
                                        profile_compat = sps_bytes[2]
                                        level_idc = sps_bytes[3]
                                        new_codec = f"avc1.{profile_idc:02X}{profile_compat:02X}{level_idc:02X}"
                                except Exception:
                                    pass

                                # 推送 config_changed 给所有在房间内的客户端
                                socketio.emit('config_changed', {
                                    'width': frag_config['width'],
                                    'height': frag_config['height'],
                                    'codec': new_codec,
                                    'sps': current_sps,
                                    'pps': cached.get('pps', ''),
                                }, to=room, namespace='/ws/camera')
                                print(f'[Camera WS] config_changed emitted to room={room}', flush=True)

                                last_sps = current_sps

                            # 清理 fragment buffer，保留最后 64KB 用于下次检测
                            if len(fragment_buffer) > 65536:
                                fragment_buffer = fragment_buffer[-32768:]

                    # 更新 fragment_buffer（用于 config_changed 检测）
                    if box_type == b'moof':
                        fragment_buffer += box_data
                    elif box_type == b'mdat':
                        fragment_buffer += box_data

                    # 推送完整的 box 数据到房间
                    socketio.emit('video_data', box_data, to=room, namespace='/ws/camera')
                    # 前几个 box 打印日志便于诊断
                    if chunk_count <= 10 and init_sent:
                        box_label = box_type.decode('ascii', errors='replace')
                        print(f'[Camera WS] project={pid} box[{box_label}] size={len(box_data)} bytes', flush=True)

        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f'[Camera WS] ERROR: Stream worker exception for project {pid}: {type(e).__name__}: {e}', flush=True)
        finally:
            print(f'[Camera WS] _stream_worker ended for project {pid}: chunks={chunk_count}, bytes={byte_count}', flush=True)
            # 清理 ffmpeg 进程
            try:
                if proc and proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=2)
            except Exception:
                pass
            # 从活跃列表中移除
            with _streams_lock:
                _active_streams.pop(pid, None)
            # 清除配置缓存
            with _configs_lock:
                _cached_configs.pop(pid, None)
            # 通知所有客户端流已结束
            socketio.emit('stream_end', {'reason': 'stream_ended'}, to=room, namespace='/ws/camera')
            print(f'[Camera WS] stream_end emitted to room={room}', flush=True)

    socketio.start_background_task(_stream_worker, project_id)

    return {'success': True}


@socketio.on('query_config', namespace='/ws/camera')
def on_query_config(data):
    """
    前端查询摄像头当前配置（分辨率、codec、SPS/PPS）
    data: { project_id: int }
    如果已缓存，立即返回；否则返回一个 pending 状态，等待 worker 解析完成后推送
    """
    print(f'[Camera WS] query_config received: {data}', flush=True)
    project_id = data.get('project_id') if isinstance(data, dict) else None
    if not project_id:
        socketio.emit('error', {'message': 'query_config 缺少 project_id'}, to=request.sid, namespace='/ws/camera')
        return

    with _configs_lock:
        cached = _cached_configs.get(project_id)

    if cached:
        # 已有缓存，直接返回
        print(f'[Camera WS] query_config: 返回缓存配置 project={project_id}', flush=True)
        socketio.emit('config_response', {
            'width': cached['width'],
            'height': cached['height'],
            'codec': cached['codec'],
            'sps': cached.get('sps', ''),
            'pps': cached.get('pps', ''),
        }, to=request.sid, namespace='/ws/camera')
    else:
        # 尚未缓存（ffmpeg 还没输出 init segment），告知前端等待
        # worker 解析到 init segment 后会自动推送 config_response
        print(f'[Camera WS] query_config: 尚未缓存 project={project_id}，等待 worker 推送', flush=True)
        # 可选：发送 pending 状态让前端知道后端已收到请求
        # 前端有 5 秒超时兜底，这里不做额外处理即可


@socketio.on('stop_stream', namespace='/ws/camera')
def on_stop_stream(data):
    """停止流"""
    project_id = data.get('project_id')
    if not project_id:
        return
    print(f'[Camera WS] stop_stream received for project {project_id}, sid={request.sid}', flush=True)
    # 先移除 client，判断是否需要停止推流
    should_stop = False
    with _streams_lock:
        info = _active_streams.get(project_id)
        if info:
            info['clients'].discard(request.sid)
            if not info['clients']:
                should_stop = True
    # 在锁外停止推流，避免死锁
    if should_stop:
        _stop_ffmpeg_stream(project_id)


# ==================== 云台控制 ====================

@camera_bp.route('/ptz/<int:project_id>', methods=['POST'])
@login_required
def ptz_control(project_id):
    """云台控制
    请求体: { "action": "up|down|left|right|zoomIn|zoomOut|focusIn|focusOut|irisIn|irisOut|stop", "speed": 5, "duration": 500 }
    speed 范围 1-10（可选，默认 5），duration 单位毫秒（可选，默认 500；stop 忽略此值）
    """
    # 在最开头打印原始请求信息（调试用）
    raw_data = request.get_data(as_text=True)
    print(f'[PTZ RAW] project={project_id} method={request.method} content_type={request.content_type} body={raw_data}', flush=True)

    project, err = _get_project(project_id)
    if err:
        print(f'[PTZ API] project={project_id} ERROR: _get_project failed: {err}', flush=True)
        return err

    cam, cam_err = get_project_camera(project)
    if cam_err:
        print(f'[PTZ API] project={project_id} ERROR: get_project_camera failed: {cam_err}', flush=True)
        return error(cam_err)

    data = request.get_json() or {}
    action = data.get('action', '')
    speed = data.get('speed', 5)
    duration = data.get('duration', 500)

    print(f'[PTZ API] project={project_id} action={action} speed={speed} duration={duration}', flush=True)

    if not action:
        return error('缺少控制动作(action)')

    # 在 gevent greenlet 中异步执行 PTZ 操作，不阻塞 Flask 请求处理
    # 这样前端每 200ms 的请求都能被立即处理，且 gevent 可正确调度 greenlet 切换
    import gevent
    gevent.spawn(_do_ptz, cam, action, speed, duration)
    return success(message='控制成功')


def _do_ptz(cam, action, speed, duration):
    """在 gevent greenlet 中执行 PTZ 操作，避免阻塞 stream_worker"""
    ok, msg = cam.ptz_action(action, speed=speed, duration_ms=duration)
    print(f'[PTZ API] result: ok={ok} msg={msg}', flush=True)


# ==================== 分辨率管理 ====================

@camera_bp.route('/resolutions/<int:project_id>', methods=['GET'])
@login_required
def get_resolutions(project_id):
    """获取摄像头支持的可用分辨率列表"""
    project, err = _get_project(project_id)
    if err:
        return err

    cam, cam_err = get_project_camera(project)
    if cam_err:
        return error(cam_err)

    resolutions, res_err = cam.get_resolutions()
    if res_err:
        return error(res_err)

    return success(data=resolutions)


@camera_bp.route('/resolution/<int:project_id>', methods=['PUT'])
@login_required
def set_resolution(project_id):
    """设置摄像头分辨率
    请求体: { "width": 1920, "height": 1080 }
    """
    project, err = _get_project(project_id)
    if err:
        return err

    cam, cam_err = get_project_camera(project)
    if cam_err:
        return error(cam_err)

    data = request.get_json() or {}
    width = data.get('width')
    height = data.get('height')

    if not width or not height:
        return error('缺少分辨率参数')

    ok, msg = cam.set_resolution(width, height)
    if ok:
        return success(message='分辨率设置成功，可能需要重启预览')
    return error(f'设置失败: {msg}')
