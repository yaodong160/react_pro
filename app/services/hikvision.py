"""
海康威视 ISAPI 协议服务层
基于 HTTP ISAPI 协议，无需安装 SDK，通过 requests 调用摄像头 CGI 接口。
支持：抓图、MJPEG 预览、云台控制、分辨率管理
"""
import threading
from urllib.parse import urljoin
import requests
from requests.auth import HTTPDigestAuth

# gevent 环境下用 gevent.sleep 代替 time.sleep，避免阻塞其他 greenlet
try:
    from gevent import sleep as gsleep
except ImportError:
    gsleep = None


class HikvisionCamera:
    """海康摄像头 ISAPI 封装"""

    def __init__(self, base_url, username, password, timeout=10):
        """
        base_url: 如 http://192.168.1.64
        username: 摄像头用户名
        password: 摄像头密码
        """
        self.base_url = base_url.rstrip('/')
        self.username = username
        self.password = password
        self.timeout = timeout
        self.auth = HTTPDigestAuth(username, password)
        self._session = requests.Session()
        self._session.auth = self.auth

    def _isapi(self, path):
        """拼接 ISAPI 完整 URL"""
        return urljoin(self.base_url + '/', path.lstrip('/'))

    def _check_connection(self):
        """检查摄像头连通性"""
        try:
            resp = self._session.get(
                self._isapi('/ISAPI/System/deviceInfo'),
                timeout=5
            )
            return resp.status_code == 200
        except Exception:
            return False

    # ==================== 抓图 ====================

    def capture(self):
        """
        截取当前帧，返回 (image_bytes, content_type)
        失败返回 (None, error_msg)
        """
        try:
            resp = self._session.get(
                self._isapi('/ISAPI/Streaming/channels/1/picture'),
                timeout=self.timeout
            )
            if resp.status_code == 200 and resp.content:
                content_type = resp.headers.get('Content-Type', 'image/jpeg')
                return resp.content, content_type
            return None, f"抓图失败: HTTP {resp.status_code}"
        except requests.RequestException as e:
            return None, str(e)

    def capture_to_file(self, file_path):
        """截取并保存到文件，返回 True/False"""
        img_bytes, error = self.capture()
        if img_bytes:
            with open(file_path, 'wb') as f:
                f.write(img_bytes)
            return True
        return False

    # ==================== RTSP 流 ====================

    def get_rtsp_url(self, channel=1, subtype=1):
        """
        获取 RTSP URL（H.264/H.265 主/子码流）
        channel: 通道号 (1-based)
        subtype: 0=主码流, 1=子码流
        海康默认 RTSP 格式: rtsp://user:pass@ip:port/Streaming/Channels/{channel}{subtype}01
        """
        # 从 base_url 提取 host:port
        from urllib.parse import urlparse
        parsed = urlparse(self.base_url)
        host_port = parsed.netloc  # 如 192.168.1.64:554 或 192.168.1.64
        if ':' not in host_port:
            host_port = f'{host_port}:554'  # 默认 RTSP 端口

        # URL 编码用户名密码中的特殊字符
        from urllib.parse import quote
        user = quote(self.username, safe='')
        pwd = quote(self.password, safe='')
        # 海康 RTSP 路径格式: /Streaming/Channels/{channel}0{subtype}
        # channel=1, subtype=1 → 101 (子码流)
        # channel=1, subtype=0 → 100 (主码流，注意不是 1101)
        # 注：部分型号也支持 {channel}{subtype}01 格式(如 1101=主码流)，但 101 更通用
        return f'rtsp://{user}:{pwd}@{host_port}/Streaming/Channels/{channel}0{subtype}'

    # ==================== MJPEG 预览 ====================

    # 海康 MJPEG 可能端点列表（按优先级排列）
    _MJPEG_PATHS = [
        '/ISAPI/Streaming/channels/{ch}01/httpPreview',
        '/ISAPI/Streaming/channels/{ch}01/httppreview',
        '/ISAPI/Streaming/channels/{ch}01/preview',
        '/Streaming/channels/{ch}01/httpPreview',
        '/Streaming/channels/{ch}01/httppreview',
        '/Streaming/channels/{ch}01/preview',
    ]

    def get_mjpeg_url(self, channel=1):
        """
        自动探测可用的 MJPEG 子码流 URL
        返回 (url, None) 成功，或 (None, error) 失败
        """
        for path_template in self._MJPEG_PATHS:
            url = self._isapi(path_template.format(ch=channel))
            try:
                resp = self._session.get(url, stream=True, timeout=(3, 1))
                # 检查响应是否是 MJPEG 流（multipart/x-mixed-replace）
                content_type = resp.headers.get('Content-Type', '')
                if resp.status_code == 200 and 'multipart/x-mixed-replace' in content_type:
                    resp.close()
                    return url, None
                resp.close()
            except Exception:
                continue
        return None, '所有 MJPEG 端点均不可用，请确认摄像头已开启子码流 MJPEG 功能'

    @property
    def mjpeg_url(self):
        """缓存的 MJPEG URL"""
        if not hasattr(self, '_mjpeg_url'):
            url, err = self.get_mjpeg_url()
            if err:
                raise RuntimeError(err)
            self._mjpeg_url = url
        return self._mjpeg_url

    def mjpeg_stream_generator(self, channel=1):
        """
        生成器：持续从摄像头拉取 MJPEG 帧，yield (frame_bytes, boundary)
        用于后端代理流，配合 multipart/x-mixed-replace 响应
        """
        url, url_err = self.get_mjpeg_url(channel)
        if url_err:
            yield None, url_err
            return

        try:
            resp = self._session.get(url, stream=True, timeout=(5, None))
            if resp.status_code != 200:
                yield None, f"无法连接摄像头: HTTP {resp.status_code}"
                return

            boundary = None
            content_type = resp.headers.get('Content-Type', '')
            if 'boundary=' in content_type:
                boundary = content_type.split('boundary=')[-1].strip()

            buffer = b''
            for chunk in resp.iter_content(chunk_size=4096):
                if not chunk:
                    break
                buffer += chunk

                # 按 boundary 切分帧
                if boundary:
                    boundary_bytes = f'--{boundary}'.encode()
                    while boundary_bytes in buffer:
                        idx = buffer.find(boundary_bytes)
                        if idx == -1:
                            break
                        # 找到下一帧的起始
                        next_idx = buffer.find(boundary_bytes, idx + len(boundary_bytes))
                        if next_idx == -1:
                            break
                        frame_data = buffer[idx:next_idx]
                        buffer = buffer[next_idx:]
                        # 提取 JPEG 数据
                        header_end = frame_data.find(b'\r\n\r\n')
                        if header_end != -1:
                            jpeg_data = frame_data[header_end + 4:]
                            if jpeg_data.strip():
                                yield jpeg_data, boundary
                else:
                    # 无 boundary，直接 yield 每段数据
                    if buffer:
                        yield buffer, None
                        buffer = b''

        except requests.RequestException as e:
            yield None, str(e)

    # ==================== 云台控制 ====================

    def _ptz_control(self, pan=0, tilt=0, zoom=0, focus=0, iris=0, duration_ms=500):
        """
        云台连续运动控制
        pan: 水平 -100~100 (负=左，正=右)
        tilt: 垂直 -100~100 (负=下，正=上)
        zoom: 变焦 -100~100 (负=缩小，正=放大)
        focus: 聚焦 -100~100 (负=近焦/拉近，正=远焦/拉远)
        iris: 光圈 -100~100 (负=缩小光圈，正=开大光圈)
        duration_ms: 运动持续时间(毫秒)，>0 则等待后自动停止
        """
        xml_parts = ['<PTZData>']
        if pan:
            xml_parts.append(f'<pan>{pan}</pan>')
        if tilt:
            xml_parts.append(f'<tilt>{tilt}</tilt>')
        if zoom:
            xml_parts.append(f'<zoom>{zoom}</zoom>')
        if focus:
            xml_parts.append(f'<focus>{focus}</focus>')
        if iris:
            xml_parts.append(f'<iris>{iris}</iris>')
        xml_parts.append('</PTZData>')
        xml_body = ''.join(xml_parts)

        headers = {'Content-Type': 'application/xml'}

        url = self._isapi('/ISAPI/PTZCtrl/channels/1/continuous')

        try:
            print(f'[PTZ] PUT {url} pan={pan} tilt={tilt} zoom={zoom} focus={focus} iris={iris} duration_ms={duration_ms}', flush=True)
            # 使用独立的 HTTP 连接，不复用 session 连接池，避免与 RTSP 流冲突
            resp = requests.put(
                url, data=xml_body, headers=headers,
                auth=self.auth, timeout=self.timeout
            )
            print(f'[PTZ] Response: HTTP {resp.status_code}, body={resp.text[:300]}', flush=True)

            if resp.status_code in (200, 202, 204):
                # duration_ms > 0 时等待后自动停止
                # 使用 gevent.sleep 避免阻塞其他 greenlet（协程友好）
                if duration_ms > 0:
                    sleep_fn = gsleep if gsleep else __import__('time').sleep
                    sleep_fn(duration_ms / 1000.0)
                    # 构建停止 XML，只包含非零字段的归零
                    stop_parts = ['<PTZData>']
                    if pan:
                        stop_parts.append('<pan>0</pan>')
                    if tilt:
                        stop_parts.append('<tilt>0</tilt>')
                    if zoom:
                        stop_parts.append('<zoom>0</zoom>')
                    if focus:
                        stop_parts.append('<focus>0</focus>')
                    if iris:
                        stop_parts.append('<iris>0</iris>')
                    stop_parts.append('</PTZData>')
                    stop_xml = ''.join(stop_parts)
                    print(f'[PTZ] Auto-stop after {duration_ms}ms, stop_xml={stop_xml}', flush=True)
                    requests.put(
                        url, data=stop_xml, headers=headers,
                        auth=self.auth, timeout=self.timeout
                    )
                return True, 'ok'
            else:
                return False, f"PTZ 控制失败: HTTP {resp.status_code}, 响应: {resp.text[:500]}"
        except requests.RequestException as e:
            print(f'[PTZ] Request error: {e}', flush=True)
            return False, str(e)

    def ptz_up(self, speed=5, duration_ms=500):
        return self._ptz_control(tilt=speed, duration_ms=duration_ms)

    def ptz_down(self, speed=5, duration_ms=500):
        return self._ptz_control(tilt=-speed, duration_ms=duration_ms)

    def ptz_left(self, speed=5, duration_ms=500):
        return self._ptz_control(pan=-speed, duration_ms=duration_ms)

    def ptz_right(self, speed=5, duration_ms=500):
        return self._ptz_control(pan=speed, duration_ms=duration_ms)

    def ptz_zoom_in(self, speed=5, duration_ms=500):
        return self._ptz_control(zoom=speed, duration_ms=duration_ms)

    def ptz_zoom_out(self, speed=5, duration_ms=500):
        return self._ptz_control(zoom=-speed, duration_ms=duration_ms)

    def ptz_stop(self, speed=5, duration_ms=0):
        """停止所有云台运动"""
        return self._ptz_control(pan=0, tilt=0, zoom=0, focus=0, iris=0, duration_ms=0)

    def ptz_action(self, action, speed=5, duration_ms=500):
        """统一的云台控制接口
        speed: 移动速度 1-10，映射到海康 ISAPI 的 10-100
        duration_ms: 运动持续时间(毫秒)，stop 时为 0
        """
        # 映射前端 speed 1~10 到 ISAPI 的 10~100
        isapi_speed = max(10, min(100, int(speed) * 10))
        actions = {
            'up': lambda: self._ptz_control(tilt=isapi_speed, duration_ms=duration_ms),
            'down': lambda: self._ptz_control(tilt=-isapi_speed, duration_ms=duration_ms),
            'left': lambda: self._ptz_control(pan=-isapi_speed, duration_ms=duration_ms),
            'right': lambda: self._ptz_control(pan=isapi_speed, duration_ms=duration_ms),
            'zoomIn': lambda: self._ptz_control(zoom=isapi_speed, duration_ms=duration_ms),
            'zoomOut': lambda: self._ptz_control(zoom=-isapi_speed, duration_ms=duration_ms),
            'focusIn': lambda: self._ptz_control(focus=isapi_speed, duration_ms=duration_ms),
            'focusOut': lambda: self._ptz_control(focus=-isapi_speed, duration_ms=duration_ms),
            'irisIn': lambda: self._ptz_control(iris=isapi_speed, duration_ms=duration_ms),
            'irisOut': lambda: self._ptz_control(iris=-isapi_speed, duration_ms=duration_ms),
            'stop': lambda: self._ptz_control(pan=0, tilt=0, zoom=0, focus=0, iris=0, duration_ms=0),
        }
        fn = actions.get(action)
        if fn:
            return fn()
        return False, f'不支持的动作: {action}'

    # ==================== 分辨率 ====================

    def get_capabilities(self):
        """获取通道能力集（含支持的分辨率列表）"""
        try:
            resp = self._session.get(
                self._isapi('/ISAPI/Streaming/channels/1/capabilities'),
                timeout=self.timeout
            )
            if resp.status_code == 200:
                return resp.text, None
            return None, f"获取能力集失败: HTTP {resp.status_code}"
        except requests.RequestException as e:
            return None, str(e)

    def get_resolutions(self):
        """
        解析并返回可用分辨率列表
        返回: [(width, height, label), ...]
        """
        xml_text, error = self.get_capabilities()
        if error:
            return [], error

        # 简单解析 XML 中的分辨率
        import re
        resolutions = []
        seen = set()
        # 匹配 <resolutionWidth>1920</resolutionWidth><resolutionHeight>1080</resolutionHeight>
        pattern = r'<resolutionWidth>(\d+)</resolutionWidth>\s*<resolutionHeight>(\d+)</resolutionHeight>'
        matches = re.findall(pattern, xml_text)
        for w, h in matches:
            key = (int(w), int(h))
            if key not in seen:
                seen.add(key)
                resolutions.append({'width': key[0], 'height': key[1], 'label': f'{w}×{h}'})

        if not resolutions:
            # 回退：尝试常见分辨率
            resolutions = [
                {'width': 1920, 'height': 1080, 'label': '1920×1080'},
                {'width': 1280, 'height': 720, 'label': '1280×720'},
                {'width': 704, 'height': 576, 'label': '704×576'},
            ]
        return resolutions, None

    def set_resolution(self, width, height):
        """设置主码流分辨率"""
        xml_body = (
            '<StreamingChannel>'
            '<id>1</id>'
            '<Video>'
            '<resolutionWidth>' + str(width) + '</resolutionWidth>'
            '<resolutionHeight>' + str(height) + '</resolutionHeight>'
            '</Video>'
            '</StreamingChannel>'
        )
        headers = {'Content-Type': 'application/xml'}
        try:
            resp = self._session.put(
                self._isapi('/ISAPI/Streaming/channels/1'),
                data=xml_body, headers=headers, timeout=self.timeout
            )
            return resp.status_code in (200, 202), resp.text
        except requests.RequestException as e:
            return False, str(e)


# ==================== 摄像头连接池 ====================

_camera_pool = {}
_pool_lock = threading.Lock()


def get_camera(base_url, username, password, timeout=10):
    """获取或创建摄像头实例（按 base_url 缓存）"""
    key = f"{base_url}:{username}"
    with _pool_lock:
        if key not in _camera_pool:
            cam = HikvisionCamera(base_url, username, password, timeout)
            _camera_pool[key] = cam
        return _camera_pool[key]


def remove_camera(base_url, username):
    """从连接池移除摄像头实例"""
    key = f"{base_url}:{username}"
    with _pool_lock:
        _camera_pool.pop(key, None)


def get_project_camera(project):
    """从 AnnotationProject 对象获取摄像头实例"""
    if not project.camera_url:
        return None, '项目未配置摄像头'
    if not project.camera_username:
        return None, '摄像头用户名未配置'
    if not project.camera_password:
        return None, '摄像头密码未配置'

    cam = get_camera(project.camera_url, project.camera_username, project.camera_password)
    return cam, None
