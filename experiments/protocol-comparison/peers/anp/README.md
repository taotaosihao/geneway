# 固定 AWiki 独立 ANP peer

此目录只启动固定上游 AWiki Open Server，不 import 受测 Geneway adapter。Host、DID 文档签名、Group DID/receipt、成员状态、消息顺序、SQLite/objects 与 Group outbox 均来自真实上游实现。

固定源码：`AgentConnect/awiki-open-server@09d38fd8afc803c16ab61cd629c0c8ea3747edc6`。外 Git checkout/venv 位于 `/home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-comparison-sources/awiki-open-server`。实际安装采用 Python 3.11.15 与原 `uv.lock` 的 `uv sync --frozen --python /home/gewu/.local/bin/python3.11 --group dev`；没有改上游 lock 或 production 根依赖。完整实际包、版本与许可证元数据在同源目录旁 `awiki-installation-provenance.json`，元数据未声明许可证者不推断已审查。

```js
import { startAnpPeer, createPeerIdentity, peerCommand } from './peers/anp/run.mjs'

const peer = await startAnpPeer({
  root: externalPeerRoot,
  host: '127.0.0.1',
  port: 0,
  didDomain: 'group-host.test',
  resolverBaseUrls: { 'adapter-home.test': adapterReceiverOrigin },
})
// peer.origin / peer.child / peer.identity / peer.versions / peer.close()
const owner = await createPeerIdentity(peer, { handle: 'peer-owner' })
```

最小 CLI：`node peers/anp/run.mjs --config /absolute/peer-config-input.json`。输入即上面 options；首 ready stdout 为 `{event:'ready',origin,pid,protocol:'anp',versions}`，其他 server 日志只到 stderr 与 peer root 日志。原 root 重启复用端口、DID 域、服务 key 与 SQLite；不要用同 root 改 origin。

`resolverBaseUrls` 使用官方 `AWIKI_DID_RESOLVER_BASE_URLS`，只将指定测试 DID 域映射到本地 HTTP；这是上游支持的本地 resolver gate，不是公网 DNS/TLS 实测，也没有全局关闭 TLS 验证。服务设置明确 `AWIKI_ALLOW_UNSIGNED_PEER_DEV=0`。adapter 自有 sender DID 的文档须由其自身 key 签名，`ANPMessageService.serviceDid` 指向 adapter 自有 Home Service DID，`serviceEndpoint` 为实际 adapter receiver URL；HTTP hop 签名 key 必须由此 Home DID 授权。

公开 `anp.get_capabilities` 同样要求标准 envelope：`{meta:{profile:"anp.core.binding.v1",security_profile:"transport-protected",operation_id:"caps-1"},body:{}}`。裸 `params:{}` 会得到 `anp.invalid_params_shape`。真实结果的 `service_did/profiles/security_profiles/methods` 都在 `result` 顶层。

## 本地建群与公开成员 wire

上游禁止公开远端 `group.create`，返回 `group.remote_create_not_allowed`。本独立 peer 的本地域 owner 通过实际注册取得 bearer，再以真实 owner origin proof 在 `/im/rpc` 创建；这不授予 adapter 该 owner 或 Host key。

```js
const created = await peerCommand(peer, {
  operation: 'rpc', handle: 'peer-owner', method: 'group.create', operationId: 'group-create-1',
  body: {
    group_profile: { display_name: 'Independent comparison group' },
    group_policy: {
      message_security_profile: 'transport-protected', bootstrap_security_profile: 'transport-protected',
      admission_mode: 'open-join',
      permissions: { send:'member', add:'admin', remove:'admin', update_profile:'admin', update_policy:'owner' },
      max_members: '100',
    },
  },
})
```

adapter 使用自己的 Home 和 actor 双签向发现所得公开 `/anp-im/rpc` 发 `group.join/send/get_info`。JSON-RPC `id` 必须为非空字符串，params 为：

```json
{
  "meta": {
    "profile":"anp.group.base.v2", "security_profile":"transport-protected",
    "sender_did":"did:wba:adapter-home.test:users:...",
    "target":{"kind":"group","did":"<actual returned group DID>"},
    "operation_id":"join-1", "content_type":"application/json"
  },
  "body": {},
  "auth":{"scheme":"anp-rfc9421-origin-proof-v1","origin_proof":{"contentDigest":"...","signatureInput":"...","signature":"..."}}
}
```

`group.send` 另需 `meta.message_id`，正文为 `body.payload`。origin proof 签名输入为 JCS `{method,meta,body}` 的 Content-Digest，加 `@method`（JSON-RPC method）、`@target-uri`（`anp://group/<percent-encoded DID>`）和 `@signature-params`，用 sender actor 自身 Ed25519 key 签名。独立 peer 的 `member.py` 是自身 actor 的原生 cryptography/JCS 实现；不会代签 adapter。公开 HTTP 另须真实服务 HTTP Signature，算法由原 AWiki/anp SDK 验证，不把 bearer 或 origin proof 冒作 hop signature。

反向消息由真实 `peerCommand(...group.send...)` 触发 Host outbox，按公开 DID/服务发现向 adapter receiver 发送真实 `group.incoming`，携真实 Group receipt 和 Host HTTP 签名。初始本地预检只证实了 owner/member 注册、group.create/join、双方 send 接纳，以及双方通过 `group.list_messages` 查见两条原消息；尚不替远端 incoming 已送达。`inbox.get` 的 direct inbox 不含本地 group history。

## 证据与声明

peer root 保存 `wire.jsonl`、`service-did-document.json`、进程 ready/exit、私有成员 key/注册身份及 `data/awiki-open-server.sqlite3`、`data/objects`、`data/group-keys`。这些是原协议事实，不由测试生成 receipt。后续 wire 的 Authorization/Cookie 已遮蔽，签名头保留；旧预检原 wire 保持原始证据，目录仅用于本地隔离测试，不将凭据放到控制台。

当前 DID 发现是 P2 的 DID/ANPMessageService 路径；固定 AWiki 没有单独通用 AgentDescription endpoint，不能据此宣称其独立协议已过。上游 discovery 可能广告额外 legacy/attachment/federation profiles，必须记录原声明和逐 Profile 适用测试；此预检不宣称全部 MUST、P6/P7/P8、跨公网 TLS、最终 X01–X10 或 ANP 胜出。
