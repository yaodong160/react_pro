# 标注坐标数据格式约定

> 本文档定义前端标注组件与后端训练平台之间的坐标数据交换格式。

---

## 一、接口

### 保存标注结果

```
POST /annotation/result/save
```

**请求体**：

```json
{
  "projectId": 1,
  "imageId": 101,
  "regions": [
    {
      "type": "create-box",
      "cls": "红绿灯",
      "tags": ["白天", "路口"],
      "comment": "遮挡严重",
      "color": "#f44336",
      "points": [[0.35, 0.42], [0.55, 0.42], [0.55, 0.68], [0.35, 0.68]]
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectId` | number | 是 | 项目 ID |
| `imageId` | number | 是 | 图片 ID |
| `regions` | RegionData[] | 是 | 标注区域列表 |

### RegionData 结构

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | `"create-box"` / `"create-polygon"` / `"create-point"` |
| `cls` | string | 是 | 分类名称 |
| `tags` | string[] | 否 | 标签列表 |
| `comment` | string | 否 | 注释说明 |
| `color` | string | 否 | 标注框颜色（hex），如 `"#f44336"` |
| `points` | number[][] | 是 | 坐标点数组 |

---

## 二、坐标系

| 项目 | 约定 |
|------|------|
| **坐标系** | **归一化坐标 (normalized)** |
| **值范围** | `[0, 1]`，相对于图片原始尺寸 |
| **原点** | 图片**左上角** `(0, 0)` |
| **x 轴方向** | 向右 |
| **y 轴方向** | 向下 |

### 后端还原像素坐标

```
pixel_x = normalized_x × image_width
pixel_y = normalized_y × image_height
```

后端需要获取图片的原始尺寸 `image_width` × `image_height`（可从图片文件元数据读取，或在上传时记录到图片表）。

---

## 三、各类型 points 格式

### 矩形 `create-box`

4 个角点，逆时针从左上角开始：

```json
{
  "type": "create-box",
  "points": [[x1, y1], [x2, y2], [x3, y3], [x4, y4]]
}
```

```
(x1,y1) ──── (x2,y1)
   │            │
(x1,y2) ──── (x2,y2)
```

### 多边形 `create-polygon`

顶点数组，按绘制顺序排列：

```json
{
  "type": "create-polygon",
  "points": [[x1, y1], [x2, y2], [x3, y3], ...]
}
```

### 点 `create-point`

单点坐标：

```json
{
  "type": "create-point",
  "points": [[x, y]]
}
```

---

## 四、示例

### 示例 1：图片中心区域的矩形框

图片尺寸 1920×1080，标注图片中央 200×100 区域：

```json
{
  "type": "create-box",
  "cls": "汽车",
  "tags": [],
  "points": [[0.40, 0.45], [0.50, 0.45], [0.50, 0.55], [0.40, 0.55]]
}
```

后端还原：
```
x_min = 0.40 × 1920 = 768
y_min = 0.45 × 1080 = 486
width = (0.50 - 0.40) × 1920 = 192
height = (0.55 - 0.45) × 1080 = 108
```

### 示例 2：三角形多边形

```json
{
  "type": "create-polygon",
  "cls": "路标",
  "tags": ["限速"],
  "points": [[0.30, 0.60], [0.35, 0.40], [0.40, 0.60]]
}
```

### 示例 3：点标注

```json
{
  "type": "create-point",
  "cls": "行人",
  "points": [[0.25, 0.70]]
}
```

---

## 五、注意事项

1. 归一化坐标由前端 `react-image-annotate` 库内部计算，所有鼠标事件坐标均除以图片显示尺寸得到 0~1 范围的值。
2. 归一化的分母是图片在 canvas 上的**显示尺寸**（与原始像素尺寸等比例），因此归一化坐标在不同缩放级别下保持一致。
3. 后端如需转换为像素坐标，必须使用图片**原始像素尺寸**进行计算。
4. 坐标值可能包含小数，建议使用 `float64` 存储以保证精度。
