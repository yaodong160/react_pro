1. 初始配置 (仅需执行一次)
在开始任何 Git 操作前，确保本地已配置用户信息。

powershell
# 设置全局用户名和邮箱
git config --global user.name "yaodong160"
git config --global user.email "你的邮箱@example.com"

# 查看当前配置
git config --list
2. 日常开发提交流程
这是最常用的“修改-提交-推送”循环。

第一步：查看状态
powershell
git status
红色文件：未暂存的修改。
绿色文件：已暂存，准备提交。
第二步：添加文件到暂存区
powershell
# 添加所有修改的文件
git add .

# 或者只添加指定文件
git add src/components/Header.tsx
第三步：提交到本地仓库
powershell
# 简短提交
git commit -m "feat: 新增用户管理页面"

# 详细提交（会打开编辑器写多行描述）
git commit
提示：本项目配置了 husky，提交时会自动运行 ESLint 检查。如果报错，请先运行 npm run lint:fix 修复代码。

第四步：推送到远程仓库
powershell
# 首次推送（已执行过，后续只需 git push）
git push -u origin main

# 日常推送
git push
3. 拉取与同步代码 

markdown
## 0. 首次获取项目 (Clone)
如果是第一次在一台新电脑上操作该项目：

```powershell
# 克隆仓库
git clone https://github.com/yaodong160/react_pro.git

# 进入目录
cd react_pro

# 安装依赖
pnpm install
当你在其他地方修改了代码，或需要合并队友的代码时。

powershell
# **正常拉取远程最新代码并自动合并
git pull

# 如果担心冲突，可以先 fetch 再手动 merge
git fetch origin
git merge origin/main
4. 分支管理
建议不要在 main 分支直接开发，使用功能分支。

powershell
# 创建并切换到新分支
git checkout -b feat/login-page

# 查看当前所有分支
git branch

# 切换回主分支
git checkout main

# 删除本地分支
git branch -d feat/login-page
5. 常见问题处理
A. 推送失败：远程有更新
powershell
# 先拉取再推送
git pull --rebase origin main
git push
B. 撤销修改
powershell
# 撤销工作区的修改（未 add）
git checkout -- <文件名>

# 撤销暂存区的文件（已 add 但未 commit）
git reset HEAD <文件名>

# 撤销上一次提交（已 commit 但未 push）
git reset --soft HEAD~1

1. 查看远程更新（不拉取）
bash
# 查看远程有哪些新提交（只查不拉）
git fetch origin

# 查看远程分支与本地分支的差异
git log main..origin/main --oneline
2. 拉取并合并
bash
# 拉取远程代码并自动合并到本地（推荐）
git pull origin main

# 或者用 rebase 方式（保持提交历史线性）
git pull --rebase origin main
3. 常用组合流程
bash
# 1. 先保存本地未提交的修改（如果有）
git stash

# 2. 拉取最新代码
git pull origin main

# 3. 恢复本地修改
git stash pop
4. 查看状态
bash
# 查看当前分支和远程的同步状态
git status

# 查看本地和远程的提交差异图
git log --oneline --graph --all