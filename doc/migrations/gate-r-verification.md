# Gate R 验收记录

验收日期：2026-07-19（Asia/Shanghai）

状态：**已关闭。**

用户确认时间：2026-07-19（Asia/Shanghai）

用户已确认：

- `taotaosihao/geneway` 和 `/home/gewu/work/geneway` 是后续唯一产品代码基地；
- MVP 阶段保持私有仓库和单一 Admin；
- 在当前 GitHub 套餐不支持私有仓库分支保护期间，以禁止 force-push 的操作规程代替服务端强制保护；后续升级套餐后再启用平台保护。

## 结果

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 旧 Git 历史归档 | 通过 | `/home/gewu/work/geneway-archives/20260719/GeneWay-all-refs.bundle`、`GeneWay.git`、`SHA256SUMS` |
| 恢复演练 | 通过 | 从 bundle 实际 checkout `master` 和两个 longtask 分支，SHA 与清单一致 |
| GitHub 旧仓库归档 | 通过 | `taotaosihao/geneway-paperclip-archive-20260719` |
| 本地旧目录归档 | 通过 | `/home/gewu/work/geneway-paperclip-archive-20260719` |
| longtask/Builder 分支保存 | 通过 | 全部本地 heads 已推送归档 GitHub；bundle/bare mirror 保留全部 refs/tags |
| linked worktree 修复 | 通过 | 6 个 linked worktree 可读；HEAD、tracked 修改、untracked 文件哈希未改变 |
| 新 GitHub 仓库 | 通过 | 私有 `taotaosihao/geneway` |
| 新本地目录 | 通过 | `/home/gewu/work/geneway`，独立全新 Git 历史 |
| 初始分支保护 | 受阻 | GitHub 对当前账户的私有仓库返回 HTTP 403：需升级 GitHub Pro 或改为 public；未降低仓库私密性来绕过 |
| 访问控制 | 通过 | 仅 `taotaosihao` 为 Admin；默认分支为 `main` |
| Paperclip 隔离 | 通过 | 无 Paperclip upstream；无运行代码或 `@paperclipai/*` 依赖；只迁入权威文档和迁移资料 |
| Secret 迁移 | 通过 | 未复制任何 secret 值；新仓库 secret inventory 为空 |

## 关键引用

```text
旧归档最终 master:
ce93dae0ecf163bafeb3d59b587895be4c4330ec

codex/longtask-agent-mvp:
ae55e33520c266e2d7ebfdb74eb6b13b8cecaaac

codex/longtask-agent-mvp-implementation:
c2f6d8b978017753447cd416db1d67f8ae8db53d
```

## linked worktree 保留状态

- `/home/gewu/.codex/worktrees/3442/GeneWay`：原 1 个 untracked 文件保留。
- `builder-LON-1`：原 4 个 tracked 修改和 1 个 untracked 文件保留。
- `builder-LON-3`：原 36 个 untracked 文件保留。
- `builder-LON-61`、`builder-LON-63`、`builder-LON-76`：保持 clean。

归档期间未执行 `git worktree prune`、未清理任何旧工作树、未复制 secret 值。

## 下一门禁

Gate R 已正式关闭。下一项可授权工作是 Gate 0.1；本次确认不自动授权 Gate 0.1、Gate 0.2 或 Gate A。
