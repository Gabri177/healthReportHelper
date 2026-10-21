# 滴析 · 部署指南

把滴析部署到一台 Linux 服务器上，让多人通过域名使用。全程大约 30 分钟。

## 1. 部署形态

- **一个 Node 进程**：Express 同时提供上传与识别接口（`/api/...`）、报告页（`/r/...`）和打包好的前端（`dist/`）。
- **前面一个 Nginx**：负责 HTTPS 和反向代理。
- **数据都在 `DATA_DIR`**（默认 `./data`）：
  - `sessions/`：正在上传、还没生成报告的文件，最长保留 6 小时；
  - `reports/`：已发布的报告和原始文件，到期（3 / 6 / 12 / 24 小时）自动删除。
- **只运行一个实例**：上传中的会话保存在进程内存里，不能开多个实例做负载均衡。不要让两个实例共用同一个 `DATA_DIR`：服务启动时会清空 `sessions/`，后启动的会删掉先启动那个的上传。

## 2. 服务器要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Linux（Ubuntu 22.04 / 24.04 等） |
| Node.js | 20 或更高（`node -v` 确认） |
| 配置 | 1 核 2 GB 起步；同时使用的人多时 2 核 4 GB |
| 磁盘 | 报告最多保留 24 小时，几 GB 足够 |
| 出网 | 能访问 `api.anthropic.com`（Claude）和 `eutils.ncbi.nlm.nih.gov`（PubMed） |

> **服务器所在地区**：Claude API 只在 Anthropic 支持的国家和地区提供，请把服务器放在支持的地区（以 Anthropic 官方的支持地区列表为准）。中国大陆的服务器通常无法直接访问 Claude API。
>
> 前端和报告页从 Google Fonts 加载字体，访客那边加载不到时会自动退回系统字体，不影响使用。

## 3. 安装与构建

把项目放到服务器上（`git clone`，或打包上传，**不要**带上 `node_modules/`、`data/`、`.env`），然后：

```bash
cd /opt/dixi
npm ci
npm run build
```

`npm run build` 会先做类型检查，再把前端打包到 `dist/`。

## 4. 配置 `.env`

```bash
cp .env.example .env
chmod 600 .env
```

### 必填

| 变量 | 说明 |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude API Key，只在服务端使用 |
| `COOKIE_SECRET` | 提取码 Cookie 的签名密钥。用 `openssl rand -hex 32` 生成。不设置的话每次重启都会换，已输入提取码的访客要重新输入 |
| `PUBLIC_BASE_URL` | 对外的域名，例如 `https://report.example.com`，分享链接会用它 |
| `PORT` | 服务监听的端口，例如 `3000`，Nginx 转发到这里（先用 `ss -ltn` 确认没被占用） |
| `HOST` | 填 `127.0.0.1`：只让本机的反向代理访问，别人不能绕过 HTTPS 直接连端口 |
| `MOCK_AI` | 必须是 `0` |

### 推荐

| 变量 | 说明 |
| --- | --- |
| `NCBI_API_KEY` | PubMed 的 API Key。不填每秒只能查 3 次，几个人同时写报告时可能有人的报告缺少文献。在 NCBI 网站注册账号后，在 Account settings → API Key Management 里免费生成 |
| `CLAUDE_MODEL` | 默认 `claude-opus-5-5` |
| `TZ_DISPLAY` | 报告页初始显示的时区，默认 `Asia/Shanghai` |

### 防滥用与费用（见第 8 节）

`CLAUDE_CONCURRENCY`、`RATE_SESSIONS_PER_HOUR`、`RATE_FILES_PER_HOUR`、`MAX_REPORTS_PER_DAY`、`TRUST_PROXY`。默认值适合小范围使用，可以先不改。

`API_PORT` 只在本地开发时用，生产环境以 `PORT` 为准。

## 5. 试运行

```bash
npm start
```

另开一个终端：

```bash
curl http://127.0.0.1:3000/api/config
```

返回 `{"mock":false,"hours":[3,6,12,24]}` 就说明正常（`mock` 必须是 `false`）。确认后按 `Ctrl+C` 停掉，交给 systemd 管理。

## 6. 用 systemd 守护进程

建一个专用用户，并把目录交给它：

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin dixi
sudo chown -R dixi:dixi /opt/dixi
```

新建 `/etc/systemd/system/dixi.service`（`ExecStart` 里的 npm 路径用 `which npm` 查；用 nvm 装的 Node 要写完整路径）：

```ini
[Unit]
Description=Dixi health report
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dixi
WorkingDirectory=/opt/dixi
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3
# 体检数据只给服务自己读写
UMask=0077

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dixi
sudo systemctl status dixi
sudo journalctl -u dixi -f      # 看日志
```

## 7. Nginx 反向代理与 HTTPS

前提：域名已解析到这台服务器，防火墙放行 80 和 443 端口。

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

新建 `/etc/nginx/sites-available/dixi`（把域名换成你的）。先写成普通的 HTTP 站点，下一步由 certbot 改成 HTTPS：

```nginx
server {
    listen 80;
    server_name report.example.com;

    # 单个文件最大 30 MB
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 识别和写报告要调用 AI，人多时还要排队，留足时间
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/dixi /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# 申请免费证书（Let's Encrypt），并自动把这个站点改成 HTTPS、加上 80 → 443 跳转
sudo certbot --nginx -d report.example.com
```

完成后用浏览器打开 `https://report.example.com` 确认。证书会自动续期。

Nginx 和服务在同一台机器上时，`TRUST_PROXY` 保持默认 `loopback` 即可。如果代理是另一台机器或云负载均衡，把 `TRUST_PROXY` 设成它的 IP / 网段，或经过的代理层数（如 `1`），否则限流会把所有人当成同一个访客。

## 8. 多人使用：防滥用与费用控制

所有人共用一把 Claude API Key。服务端内置了下面几项保护，都可以在 `.env` 里调整：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CLAUDE_CONCURRENCY` | `4` | 全站同时进行的 Claude 调用数。超出的排队等待，不会直接报错，界面上水滴照常在读。遇到「请求太频繁」就调小，账号速率等级高可以调大 |
| `RATE_SESSIONS_PER_HOUR` | `10` | 每个 IP 每小时最多开始几次解读 |
| `RATE_FILES_PER_HOUR` | `60` | 每个 IP 每小时最多上传几个文件 |
| `MAX_REPORTS_PER_DAY` | `0`（不限） | 全站每天最多生成几份报告（按 UTC 日期），用完后提示「今天的解读名额已经用完了」 |

另外几项不需要配置：

- **PubMed 请求**全站统一排队，保证不超过 NCBI 的速率限制（有 `NCBI_API_KEY` 时每秒 10 次，没有时 3 次）。
- **提取码**按「报告 + 访客 IP」计次：同一个人输错 8 次锁 10 分钟，只锁他自己，不影响其他拿到链接的人。

费用参考：每份报告大约要调用 Claude「文件数 + 4」次（每个文件识别一次，查文献一次，分三部分写报告各一次）。

建议再加两层兜底：

1. **在 Anthropic Console 给 API Key 所在的 Workspace 设置每月花费上限**，到额后 Claude 会拒绝请求，不会继续扣费。
2. **只给特定的人用**时，用 Nginx 加一个访问口令。分享出去的报告链接（`/r/`）要保持开放，收到链接的人才能打开：

   ```bash
   sudo apt install apache2-utils
   sudo htpasswd -c /etc/nginx/.dixi_htpasswd 用户名
   ```

   在 `/etc/nginx/sites-available/dixi` 里（certbot 改过之后，是 `listen 443 ssl` 的那个 `server`），把原来的 `location /` 换成下面两段，然后 `sudo nginx -t && sudo systemctl reload nginx`：

   ```nginx
   location / {
       auth_basic "滴析";
       auth_basic_user_file /etc/nginx/.dixi_htpasswd;
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 300s;
       proxy_send_timeout 300s;
       proxy_buffering off;
   }

   # 报告链接不需要口令（有提取码的报告仍要输入提取码）
   location /r/ {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

注意：公司、学校等网络里很多人共用一个出口 IP，按 IP 的限额会被他们一起用掉。这类场景请把 `RATE_*` 调大，或改用上面的访问口令。

## 9. 不同用户之间的隔离

- 每个访客的上传属于各自的会话。会话编号是 18 位随机串，只保存在他自己浏览器的页面里，文件放在以它命名的独立目录中。
- 报告链接是 10 位随机编号，可再加 6 位提取码。解锁凭证按报告分别签发，打开一份报告不会解锁别的报告。销毁报告需要只有生成者持有的凭证。
- 多人同时上传、写报告互不阻塞，只在 Claude 调用多时按顺序排队（见第 8 节）。

## 10. 更新版本

```bash
cd /opt/dixi
git pull                 # 或上传新版本的文件
npm ci
npm run build
sudo systemctl restart dixi
```

重启会让正在上传、还没生成报告的访客需要重新开始（已发布的报告不受影响），尽量选人少的时候更新。

## 11. 数据与隐私

- 体检文件和报告只保存在 `DATA_DIR`，到期自动删除，**不要**把 `DATA_DIR` 纳入备份。
- `UMask=0077` 让数据只有服务用户能读。
- 上传的文件会发送给 Anthropic 的 Claude API 做识别和解读，请在对外说明（如隐私说明）中告知用户。查 PubMed 时只发送英文的医学检索词（如「hyperuricemia diet」），不含个人信息。
- 报告链接本身就是访问凭证，Nginx 访问日志里会出现 `/r/<编号>`。建议缩短访问日志的保留时间，或在 `location /r/` 里加 `access_log off;`。
- 服务日志只记录错误信息，不记录文件内容。

## 12. 排错

| 现象 | 原因与处理 |
| --- | --- |
| 打开网站 502 | 服务没在运行：`sudo systemctl status dixi`、`sudo journalctl -u dixi -n 100` |
| 「服务端的 API Key 无效」 | 检查 `.env` 里的 `ANTHROPIC_API_KEY`，改完 `sudo systemctl restart dixi` |
| 「请求太频繁，请稍后再试」 | Claude 速率限制：调小 `CLAUDE_CONCURRENCY`，或在 Anthropic Console 提升账号的速率等级 |
| 「AI 服务暂时不可用」 | 服务器连不上 `api.anthropic.com`：检查网络、防火墙、服务器所在地区 |
| 报告里没有「文献依据」 | 连不上 PubMed，或被限速：确认能访问 `eutils.ncbi.nlm.nih.gov`，并配置 `NCBI_API_KEY` |
| 上传大文件失败（413） | Nginx 的 `client_max_body_size` 太小 |
| 生成报告时 504 | Nginx 的 `proxy_read_timeout` 太短，至少 300 秒 |
| 每次重启后都要重新输入提取码 | 没设置 `COOKIE_SECRET` |
| 分享链接的域名不对 | 设置 `PUBLIC_BASE_URL` |
| 所有人都被「这一小时……太多了」挡住 | 反向代理的访客 IP 没传对：检查 Nginx 的 `X-Forwarded-For` 和 `TRUST_PROXY` |

健康检查：`GET /api/config`，返回 200 即正常，可以接入监控。

想先在服务器上验证页面而不花费额度，可以临时把 `MOCK_AI=1`（不调用 Claude，返回示例数据），验证完务必改回 `0` 并重启。
