# pnpm Patch 使用指南

> 说明 `patches/@amnstak__react-image-annotate@0.0.26.patch` 文件的作用和使用方式。

---

## 一、Patch 文件是什么

`patches/` 目录下的 `.patch` 文件是 **pnpm 的补丁机制**，用于修改 `node_modules` 中第三方 npm 包的源码。

当第三方库存在 bug 或需要定制行为，但又不能直接修改 `node_modules`（`pnpm install` 会覆盖）时，通过 patch 文件永久记录修改。

---

## 二、当前项目的 Patch

### 文件

```
patches/@amnstak__react-image-annotate@0.0.26.patch
```

### 目标库

`@amnstak/react-image-annotate` v0.0.26 — 图片标注组件库

### 修改内容

| 文件 | 修改 |
|------|------|
| `dist/ImageViewer.js` | 缩放逻辑修复 + 初始矩阵居中 |
| `dist/lib.js` | 缩放逻辑修复 + 初始矩阵居中 |

#### 1. 缩放逻辑修复

**原库问题**：使用 `translate → scale → translate` 方式缩放，缩放中心点计算不准确，导致图片放大时以左上角为中心而非鼠标指向点。

**修复**：改为矩阵直接计算：
```js
// 保持鼠标指向点不动
d.a *= targetScale;    // 等比例缩放 a 和 d
d.d *= targetScale;
d.e = d.e + mx * oldScale * (1 - targetScale);  // 平移补偿
d.f = d.f + my * oldScale * (1 - targetScale);
```

**缩放范围**：`0.05 ~ 3` 倍（原库为 `0.05 ~ 2`）

#### 2. 初始矩阵居中

**原库问题**：图片加载后默认偏移在左上角 `(-10, -10)`。

**修复**：根据 canvas 容器尺寸和图片显示尺寸计算居中偏移：
```js
Matrix.from(1, 0, 0, 1,
  -(canvasWidth - iw) / 2,
  -(canvasHeight - ih) / 2
)
```

---

## 三、Patch 的工作原理

```
pnpm install
  └─ 下载 @amnstak/react-image-annotate@0.0.26
       └─ 检测 patches/ 目录
            └─ 匹配 @amnstak__react-image-annotate@0.0.26.patch
                 └─ 自动应用到 node_modules/ 对应文件
```

pnpm 在安装依赖时会自动扫描 `patches/` 目录，将匹配的 patch 应用到对应的包。

---

## 四、常用命令

### 查看补丁状态

```bash
pnpm patch @amnstak/react-image-annotate@0.0.26
```

### 创建/修改补丁

```bash
# 1. 生成临时目录用于编辑
pnpm patch @amnstak/react-image-annotate@0.0.26

# 输出类似：
# Patch: You can now edit the package at:
#   C:\Users\...\AppData\Local\Temp\xxxxx

# 2. 在临时目录中修改源码

# 3. 提交修改，自动更新 patches/ 下的 .patch 文件
pnpm patch-commit 'C:\Users\...\AppData\Local\Temp\xxxxx'
```

### 删除补丁

删除 `patches/` 下对应的 `.patch` 文件，然后重新 `pnpm install`。

---

## 五、注意事项

1. **升级库版本后需重新制作补丁**：patch 文件名包含版本号 `@0.0.26`，升级到新版本后旧 patch 不再匹配。
2. **提交到 Git**：`patches/` 目录应纳入版本控制，团队成员 `pnpm install` 后自动应用。
3. **修改范围最小化**：只修改必要的代码，减少升级时的维护成本。
4. **记录修改原因**：在代码中或本文档中说明每个修改的目的，方便后续维护。
