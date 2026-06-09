"""
fMP4 init segment 解析工具

从 fMP4 init segment (ftyp+moov) 中提取：
- 视频分辨率 (width, height)
- H.264 codec 字符串 (avc1.XXXXXXXX)
- SPS / PPS NAL units (base64 编码)

MP4 box 结构：
- ftyp: 文件类型
- moov: 影片级元数据
  - trak: 轨道
    - mdia: 媒体信息
      - minf: 媒体信息容器
        - stbl: 采样表
          - stsd: 采样描述
            - avc1/avcC: H.264 编码参数 (SPS/PPS)
      - mdhd: 媒体头（无分辨率）
    - tkhd: 轨道头（含宽高）

解析策略：遍历 moov 子 box，找到 tkhd（宽高）和 avcC（SPS/PPS）。
"""
import struct
import base64
import io
from typing import Optional, Tuple, Dict


def read_box_header(data: bytes, offset: int) -> Tuple[int, int, bytes]:
    """
    读取 MP4 box header，返回 (box_size, box_type_int, box_type_bytes)
    box_size 包含 header 自身的 8 字节
    如果 box_size == 1，则后续 8 字节为 largesize（此时 box_size 返回 largesize 值）
    """
    if offset + 8 > len(data):
        raise ValueError(f"Buffer too short for box header at offset {offset}")
    size, box_type = struct.unpack('>I4s', data[offset:offset + 8])
    if size == 0:
        # box extends to end of file
        return len(data) - offset, box_type, box_type
    elif size == 1:
        # 64-bit largesize
        if offset + 16 > len(data):
            raise ValueError(f"Buffer too short for largesize at offset {offset}")
        size = struct.unpack('>Q', data[offset + 8:offset + 16])[0]
        return size, box_type, box_type
    else:
        return size, box_type, box_type


def find_box(data: bytes, target_type: bytes, start_offset: int = 0, end_offset: Optional[int] = None) -> Optional[Tuple[int, int, int]]:
    """
    在 data[start_offset:end_offset] 中查找第一个 target_type box
    返回 (box_offset, box_size, box_type_int) 或 None

    注意：这里传入的 data 可能是整个 init segment，start_offset 是 moov box 的 data 起始位置
    函数会在此范围内遍历所有子 box
    """
    if end_offset is None:
        end_offset = len(data)
    offset = start_offset
    while offset + 8 <= end_offset:
        try:
            box_size, box_type_int, _ = read_box_header(data, offset)
        except ValueError:
            break
        if box_size < 8:
            break  # 无效 box
        if box_type_int == target_type:
            return (offset, box_size, box_type_int)
        # 对于容器 box（moov, trak, mdia, minf, stbl, stsd），递归查找
        offset += box_size
    return None


def find_all_boxes(data: bytes, target_type: bytes, start_offset: int = 0, end_offset: Optional[int] = None) -> list:
    """查找所有匹配的 box（用于 stsd 中可能有多个条目）"""
    if end_offset is None:
        end_offset = len(data)
    results = []
    offset = start_offset
    while offset + 8 <= end_offset:
        try:
            box_size, box_type_int, _ = read_box_header(data, offset)
        except ValueError:
            break
        if box_size < 8:
            break
        if box_type_int == target_type:
            results.append((offset, box_size))
        offset += box_size
    return results


def parse_init_segment(data: bytes) -> Dict:
    """
    解析 fMP4 init segment，返回:
    {
        'width': int,
        'height': int,
        'codec': str,           # 如 "avc1.42E01E"
        'sps': str,             # base64 编码的 SPS NAL unit（不含 start code）
        'pps': str,             # base64 编码的 PPS NAL unit（不含 start code）
    }
    如果解析失败，返回空 dict
    """
    if len(data) < 8:
        return {}

    result = {}

    # Step 1: 找到 moov box
    moov_box = find_box(data, b'moov', 0)
    if not moov_box:
        # 可能 ftyp 在前面，跳过 ftyp 再找 moov
        try:
            ftyp_size, _, _ = read_box_header(data, 0)
            moov_box = find_box(data, b'moov', ftyp_size)
        except (ValueError, struct.error):
            pass
        if not moov_box:
            return {}

    moov_offset, moov_size, _ = moov_box
    moov_end = moov_offset + moov_size

    # Step 2: 找到 tkhd box 获取分辨率
    tkhd_box = find_box(data, b'tkhd', moov_offset + 8, moov_end)
    if tkhd_box:
        tkhd_offset = tkhd_box[0]
        # tkhd 结构 (version 0):
        # 4 bytes size + 4 bytes type
        # 1 byte version + 3 bytes flags
        # 4 bytes creation_time + 4 bytes modification_time
        # 4 bytes track_id + 4 bytes reserved
        # 4 bytes duration (x2) + 8 bytes reserved
        # 2 bytes layer + 2 bytes alternate_group + 2 bytes volume + 2 bytes reserved
        # 36 bytes matrix
        # 4 bytes width (fixed-point 16.16) + 4 bytes height
        tkhd_version = data[tkhd_offset + 8]
        if tkhd_version == 0:
            width_offset = tkhd_offset + 8 + 4*9 + 36  # 8(header) + 36 + 36(matrix)
            height_offset = width_offset + 4
        else:  # version 1
            width_offset = tkhd_offset + 8 + 4*11 + 36
            height_offset = width_offset + 4

        if height_offset + 4 <= moov_end:
            width_fp = struct.unpack('>I', data[width_offset:width_offset + 4])[0]
            height_fp = struct.unpack('>I', data[height_offset:height_offset + 4])[0]
            result['width'] = int(width_fp / 65536)   # fixed-point 16.16 → integer
            result['height'] = int(height_fp / 65536)

    # Step 3: 递归找到 avcC box（在 stsd → avc1 → avcC 路径下）
    avcc_box = find_box(data, b'avcC', moov_offset + 8, moov_end)
    if avcc_box:
        avcc_offset = avcc_box[0]
        avcc_size = avcc_box[1]
        avcc_data = data[avcc_offset + 8:avcc_offset + avcc_size]  # 跳过 box header

        # avcC 结构 (ISO 14496-15):
        # 1 byte configurationVersion (=1)
        # 1 byte AVCProfileIndication (profile_idc)
        # 1 byte profile_compatibility
        # 1 byte AVCLevelIndication (level_idc)
        # 1 byte (6 bits reserved + 2 bits lengthSizeMinusOne)
        # 1 byte (3 bits reserved + 5 bits numOfSequenceParameterSets)
        # -- SPS records --
        # 1 byte (3 bits reserved + 5 bits numOfPictureParameterSets)
        # -- PPS records --
        if len(avcc_data) < 7:
            return result

        profile_idc = avcc_data[1]
        profile_compat = avcc_data[2]
        level_idc = avcc_data[3]

        # codec 字符串: avc1.{profile_idc:02X}{profile_compat:02X}{level_idc:02X}
        result['codec'] = f"avc1.{profile_idc:02X}{profile_compat:02X}{level_idc:02X}"

        # 解析 SPS
        num_sps = avcc_data[5] & 0x1F
        offset = 6
        sps_list = []
        for _ in range(num_sps):
            if offset + 2 > len(avcc_data):
                break
            sps_len = struct.unpack('>H', avcc_data[offset:offset + 2])[0]
            offset += 2
            if offset + sps_len > len(avcc_data):
                break
            sps_nal = avcc_data[offset:offset + sps_len]
            sps_list.append(base64.b64encode(sps_nal).decode('ascii'))
            offset += sps_len

        if sps_list:
            result['sps'] = sps_list[0]  # 取第一个 SPS

        # 解析 PPS
        if offset < len(avcc_data):
            num_pps = avcc_data[offset] & 0x1F
            offset += 1
            pps_list = []
            for _ in range(num_pps):
                if offset + 2 > len(avcc_data):
                    break
                pps_len = struct.unpack('>H', avcc_data[offset:offset + 2])[0]
                offset += 2
                if offset + pps_len > len(avcc_data):
                    break
                pps_nal = avcc_data[offset:offset + pps_len]
                pps_list.append(base64.b64encode(pps_nal).decode('ascii'))
                offset += pps_len

            if pps_list:
                result['pps'] = pps_list[0]  # 取第一个 PPS

    return result


def is_init_segment(chunk: bytes) -> bool:
    """判断一个 fMP4 buffer 是否包含 init segment (moov box)"""
    if len(chunk) < 8:
        return False
    # 在 buffer 中搜索 moov box（不限于开头位置，ffmpeg 可能先输出 fragment 再输出 init segment）
    pos = 0
    while pos + 8 <= len(chunk):
        try:
            size, box_type, _ = read_box_header(chunk, pos)
        except (ValueError, struct.error):
            break
        if size < 8:
            break
        if box_type == b'moov':
            return True
        pos += size
    return False


# ==================== 从 fragment (moof+mdat) 中提取 SPS ====================
# 用于 config_changed 检测：当摄像头配置变更时，ffmpeg 输出中 SPS 内容会变化

# H.264 NAL unit type 常量
NAL_TYPE_SPS = 7
NAL_TYPE_PPS = 8
NAL_TYPE_IDR = 5  # IDR slice（关键帧，含 SPS/PPS 前的 AUD 等）

# Annex B start codes
ANNEXB_START_4 = b'\x00\x00\x00\x01'
ANNEXB_START_3 = b'\x00\x00\x01'


def _find_nal_units_in_mdat(data: bytes, mdat_offset: int, mdat_size: int) -> list:
    """
    在 mdat box 中扫描 Annex B 格式的 NAL units
    返回 [(nal_type, nal_data), ...] 列表
    nal_data 不含 start code
    """
    end = mdat_offset + mdat_size
    pos = mdat_offset + 8  # 跳过 mdat header
    nal_units = []

    while pos < end - 3:
        # 查找 start code
        if data[pos:pos + 4] == ANNEXB_START_4:
            start_len = 4
        elif data[pos:pos + 3] == ANNEXB_START_3:
            start_len = 3
        else:
            pos += 1
            continue

        nal_start = pos + start_len
        # 查找下一个 start code 确定 NAL 结束
        nal_end = nal_start
        search_pos = nal_start
        while search_pos < end - 3:
            if data[search_pos:search_pos + 4] == ANNEXB_START_4:
                nal_end = search_pos
                break
            elif data[search_pos:search_pos + 3] == ANNEXB_START_3:
                nal_end = search_pos
                break
            search_pos += 1
        else:
            nal_end = end

        nal_data = data[nal_start:nal_end]
        if len(nal_data) > 0:
            nal_type = nal_data[0] & 0x1F
            nal_units.append((nal_type, nal_data))

        pos = nal_end

    return nal_units


def parse_sps_resolution(sps_nal: bytes) -> Optional[Tuple[int, int]]:
    """
    从 H.264 SPS NAL unit 中解析分辨率 (width, height)
    返回 (width, height) 或 None

    参考 ITU-T H.264 7.3.2.1.1 Sequence parameter set data syntax
    """
    return _parse_sps_simple(sps_nal)


def _parse_sps_simple(sps_nal: bytes) -> Optional[Tuple[int, int]]:
    """
    简化版 SPS 分辨率解析：使用 bit-level 完整解析
    更可靠的方式
    """
    if len(sps_nal) < 4:
        return None

    # 跳过 nal_header (1 byte) + profile_idc (1) + constraint_flags (1) + level_idc (1) = 4 bytes
    # 然后需要解析 ue(v): seq_parameter_set_id
    data = sps_nal[1:]
    bit_pos = 24  # 3 bytes * 8 = 24 bits into data (after nal header is index 0..)

    try:
        # seq_parameter_set_id: ue(v)
        sps_id, bits = _read_ue(data, bit_pos)
        bit_pos += bits

        profile_idc = data[0]

        if profile_idc in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
            chroma_fmt, bits = _read_ue(data, bit_pos)
            bit_pos += bits
            if chroma_fmt == 3:
                bit_pos += 1  # separate_colour_plane_flag
            bit_depth_luma, bits = _read_ue(data, bit_pos)
            bit_pos += bits
            bit_depth_chroma, bits = _read_ue(data, bit_pos)
            bit_pos += bits
            bit_pos += 1  # qpprime_y_zero_transform_bypass_flag
            # seq_scaling_matrix_present_flag
            if bit_pos // 8 < len(data):
                scaling_present = (data[bit_pos // 8] >> (7 - (bit_pos % 8))) & 1
                bit_pos += 1
                if scaling_present:
                    # Too complex, give up
                    return None

        # log2_max_frame_num_minus4: ue(v)
        _, bits = _read_ue(data, bit_pos)
        bit_pos += bits

        # pic_order_cnt_type: ue(v)
        poc_type, bits = _read_ue(data, bit_pos)
        bit_pos += bits

        if poc_type == 0:
            _, bits = _read_ue(data, bit_pos)
            bit_pos += bits
        elif poc_type == 1:
            bit_pos += 1  # delta_pic_order_always_zero_flag
            _, bits = _read_se(data, bit_pos)
            bit_pos += bits
            _, bits = _read_se(data, bit_pos)
            bit_pos += bits
            num_ref, bits = _read_ue(data, bit_pos)
            bit_pos += bits
            for _ in range(num_ref):
                _, bits = _read_se(data, bit_pos)
                bit_pos += bits

        # num_ref_frames: ue(v)
        _, bits = _read_ue(data, bit_pos)
        bit_pos += bits

        # gaps_in_frame_num_value_allowed_flag: u(1)
        bit_pos += 1

        # pic_width_in_mbs_minus1: ue(v)
        width_mbs, bits = _read_ue(data, bit_pos)
        bit_pos += bits

        # pic_height_in_map_units_minus1: ue(v)
        height_mbs, bits = _read_ue(data, bit_pos)
        bit_pos += bits

        # frame_mbs_only_flag: u(1)
        if bit_pos // 8 < len(data):
            frame_only = (data[bit_pos // 8] >> (7 - (bit_pos % 8))) & 1
            bit_pos += 1
        else:
            frame_only = 1

        width = (width_mbs + 1) * 16
        height = (height_mbs + 1) * 16 * (2 - frame_only)

        return (width, height)

    except Exception:
        return None


def _read_ue(data: bytes, bit_pos: int) -> Tuple[int, int]:
    """
    读取 unsigned Exp-Golomb coded number
    返回 (value, bits_consumed)
    """
    leading_zeros = 0
    byte_idx = bit_pos // 8
    bit_idx = bit_pos % 8

    while byte_idx < len(data):
        bit = (data[byte_idx] >> (7 - bit_idx)) & 1
        if bit == 1:
            break
        leading_zeros += 1
        bit_idx += 1
        if bit_idx == 8:
            bit_idx = 0
            byte_idx += 1

    if byte_idx >= len(data):
        return 0, 0

    # Now read the value bits (leading_zeros bits after the 1)
    value = 0
    for _ in range(leading_zeros):
        bit_idx += 1
        if bit_idx == 8:
            bit_idx = 0
            byte_idx += 1
        if byte_idx >= len(data):
            break
        bit = (data[byte_idx] >> (7 - bit_idx)) & 1
        value = (value << 1) | bit

    value += (1 << leading_zeros) - 1
    bits_consumed = (byte_idx * 8 + bit_idx + 1) - bit_pos  # +1 to point after last bit
    return value, bits_consumed


def _read_se(data: bytes, bit_pos: int) -> Tuple[int, int]:
    """读取 signed Exp-Golomb coded number"""
    value, bits = _read_ue(data, bit_pos)
    if value % 2 == 0:
        return -(value // 2), bits
    else:
        return (value + 1) // 2, bits


def extract_config_from_fragment(data: bytes) -> Optional[Dict]:
    """
    从 fMP4 fragment (moof+mdat) 中提取配置信息
    扫描 mdat 中的 SPS NAL unit，解析分辨率

    返回 { 'width', 'height', 'sps' } 或 None
    """
    if len(data) < 16:
        return None

    # 找到 mdat box
    mdat_pos = None
    mdat_size = 0
    pos = 0
    while pos + 8 <= len(data):
        try:
            size, box_type, _ = read_box_header(data, pos)
        except ValueError:
            break
        if box_type == b'mdat':
            mdat_pos = pos
            mdat_size = size
            break
        pos += size

    if mdat_pos is None:
        return None

    # 在 mdat 中扫描 NAL units
    nal_units = _find_nal_units_in_mdat(data, mdat_pos, mdat_size)

    # 找 SPS (type 7)
    sps_data = None
    for nal_type, nal_bytes in nal_units:
        if nal_type == NAL_TYPE_SPS:
            sps_data = nal_bytes
            break

    if not sps_data:
        return None

    # 解析 SPS 获取分辨率
    res = parse_sps_resolution(sps_data)
    if not res:
        return None

    return {
        'width': res[0],
        'height': res[1],
        'sps': base64.b64encode(sps_data).decode('ascii'),
    }
