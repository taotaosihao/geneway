# GeneWay 旧仓库归档清单

记录日期：2026-07-19

Gate：R

归档根目录：`/home/gewu/work/geneway-archives/20260719`

## 仓库身份

- 旧 GitHub：`taotaosihao/GeneWay`，public，默认分支 `master`。
- 旧本地目录：`/home/gewu/work/GeneWay`。
- Gate R 进入时 HEAD：`5ec2069029a884683c7b8a494e042c241f0dab4c`；包含本清单的最终归档 HEAD 以外部 `refs.final.txt` 和 `SHA256SUMS` 为准。
- 旧 origin：`git@github.com:taotaosihao/GeneWay.git`。
- upstream：`https://github.com/paperclipai/paperclip.git`。
- 目标 GitHub 归档名：`taotaosihao/geneway-paperclip-archive-20260719`。
- 目标本地归档目录：`/home/gewu/work/geneway-paperclip-archive-20260719`。
- 新产品仓库：`taotaosihao/geneway`，private。
- 新产品本地目录：`/home/gewu/work/geneway`。

## 本地分支基线

| 分支 | HEAD |
| --- | --- |
| `master`（Gate R 进入时） | `5ec2069029a884683c7b8a494e042c241f0dab4c` |
| `codex/longtask-agent-mvp` | `ae55e33520c266e2d7ebfdb74eb6b13b8cecaaac` |
| `codex/longtask-agent-mvp-implementation` | `c2f6d8b978017753447cd416db1d67f8ae8db53d` |
| `codex/builder-LON-1` | `2a6e634c859fe515fef67a10847549800becfb88` |
| `codex/builder-LON-3` | `c2f6d8b978017753447cd416db1d67f8ae8db53d` |
| `codex/builder-LON-61` | `d5f4c04cdd725d4b99f7be7d361d425b63c9018d` |
| `codex/builder-LON-63` | `d5f4c04cdd725d4b99f7be7d361d425b63c9018d` |
| `codex/builder-LON-76` | `9c02add13eb282f5162e0b749ac3641c6c4e5abd` |

本地共有 806 个 tag；无 Git submodule，无 Git LFS 文件。

## Linked worktree 基线

| 路径 | 分支 | HEAD | 工作树状态 |
| --- | --- | --- | --- |
| `/home/gewu/work/GeneWay` | `master` | `5ec2069...` | clean |
| `/home/gewu/.codex/worktrees/3442/GeneWay` | `codex/longtask-agent-mvp-implementation` | `c2f6d8b...` | 1 个 untracked 文件 |
| `/home/gewu/.paperclip-worktrees/instances/longtask-mvp-3442/executions/codex/builder-LON-1` | `codex/builder-LON-1` | `2a6e634...` | 4 个 tracked 修改、1 个 untracked 文件 |
| `/home/gewu/.paperclip-worktrees/instances/longtask-mvp-3442/executions/codex/builder-LON-3` | `codex/builder-LON-3` | `c2f6d8b...` | 36 个 untracked 文件 |
| `/home/gewu/.paperclip-worktrees/instances/longtask-mvp-3442/executions/codex/builder-LON-61` | `codex/builder-LON-61` | `d5f4c04...` | clean |
| `/home/gewu/.paperclip-worktrees/instances/longtask-mvp-3442/executions/codex/builder-LON-63` | `codex/builder-LON-63` | `d5f4c04...` | clean |
| `/home/gewu/.paperclip-worktrees/instances/longtask-mvp-3442/executions/codex/builder-LON-76` | `codex/builder-LON-76` | `9c02add...` | clean |

dirty/untracked 内容属于既有工作，不在 Gate R 中提交、覆盖或清理。归档目录必须保存每个非 clean worktree 的：

- `status.txt`；
- `tracked.patch`（binary diff）；
- 当前变更文件 tar；
- 逐文件 SHA-256 manifest。

## GitHub 元数据基线

- Issue：0。
- Pull request：0。
- Release：0。
- Actions workflow：10。
- GitHub 远端分支：仅 `master`。
- Collaborator：`taotaosihao`，admin。
- Branch protection：未配置。
- Issues disabled；Wiki disabled；Projects enabled。

归档目录保存 repo、workflow、branch、collaborator、hook、ruleset、environment、secret/variable **名称**等 JSON；不导出 secret 值。

## 恢复验收

Gate R 只有在以下检查全部通过后才能切换身份：

1. `git bundle verify` 成功。
2. 从 bundle 创建临时 clone，并 checkout `master`、`codex/longtask-agent-mvp`、`codex/longtask-agent-mvp-implementation`，HEAD 与本清单一致。
3. bare mirror 包含所有 heads/tags，且 ref manifest 与源仓库一致。
4. dirty/untracked tar 可列出，SHA-256 manifest 可复核。
5. GitHub 元数据导出文件存在且不含 secret 值。
6. 归档改名后旧本地 origin 指向日期化仓库并可 fetch。
7. 所有 linked worktree 经 `git worktree repair` 后 HEAD 和 dirty/untracked hash 与切换前一致。
8. 新私有 `taotaosihao/geneway` 无 Paperclip upstream、无 Paperclip 运行依赖，且只包含新平台的计划、合同、ADR 和迁移资料。
