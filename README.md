# Homebridge WOL TV

把支持 Wake-on-LAN 的电脑、服务器或其他主机映射为 Apple Home 的 **电视配件**，支持开机、关机和真实在线状态同步。

- 为 Homebridge **v2** 开发，使用 TypeScript + ESM；已针对 Homebridge **2.5.0** 验证。
- 支持多台主机，每台主机作为独立的 TV 配件发布，使用 MAC 地址生成稳定身份。
- UDP Magic Packet 开机，可配置广播地址、发送网卡、端口和重复发送。
- 关机支持 **SSH／本地程序** 或 **HTTP(S) 接口**。
- 使用 Ping 或 TCP 探测在线状态；连续失败阈值和开关机等待窗口减少状态抖动。
- 无运行时第三方依赖，使用 Homebridge 提供的 HAP API。

## 环境要求

- Homebridge 2.x，推荐当前最新版 2.5.0。
- Node.js `^22.12.0`、`^24.0.0` 或 `^26.0.0`，推荐 Node.js 24 LTS。
- Homebridge 能向目标网段发送 UDP 广播，目标网卡及 BIOS/UEFI 已开启 WOL。
- 默认状态检测使用系统 `ping` 命令。精简容器需安装它，或改用 TCP 探测。

兼容性要求依据 [Homebridge v2 更新说明](https://github.com/homebridge/homebridge/blob/latest/CHANGELOG.md) 和 [官方插件模板](https://github.com/homebridge/homebridge-plugin-template)。电视的服务结构参考 [HAP 官方 TV 示例](https://github.com/homebridge/HAP-NodeJS/blob/latest/src/accessories/TV_accessory.ts)。

## 从源码安装

当前项目可直接在本地构建、打包安装，不依赖 npm 上存在同名包。在项目目录执行：

```sh
npm ci
npm test
npm pack
```

将生成的 `homebridge-wol-tv-1.0.0.tgz` 拷贝到 Homebridge 服务器，在其环境中安装：

```sh
npm install -g ./homebridge-wol-tv-1.0.0.tgz
```

也可在 Homebridge 开发环境执行 `npm link`，然后启动 `homebridge -D`。打包产物内含编译后的 `dist`、配置界面和示例，不需要在 Homebridge 服务器安装 TypeScript。修改源码后需重新构建并重启 Homebridge。

## 配置

在 Homebridge UI 的 WOL TV 设置里添加主机，或将以下对象放入现有 `config.json` 的 `platforms` 数组。完整示例见 [config.example.json](./config.example.json)。

```json
{
  "platform": "WolTv",
  "name": "WOL TV",
  "devices": [
    {
      "name": "客厅电脑",
      "mac": "AA:BB:CC:DD:EE:FF",
      "host": "192.168.1.100",
      "broadcastAddress": "192.168.1.255",
      "probe": "ping",
      "shutdown": {
        "type": "command",
        "command": "/usr/bin/ssh",
        "args": [
          "-o", "BatchMode=yes",
          "-o", "ConnectTimeout=3",
          "-o", "StrictHostKeyChecking=yes",
          "wol@192.168.1.100",
          "sudo -n /usr/sbin/shutdown -h now"
        ]
      }
    }
  ]
}
```

`mac` 使用目标主机的网卡地址，`host` 用于状态检测。建议为目标主机保留 DHCP 地址。示例 `192.168.1.255` 仅适用于 `192.168.1.0/24` 子网，应根据实际子网掩码填写。

**WOL 协议只支持唤醒，不支持关机。** 没有配置 `shutdown` 时仍可开机和同步状态；在线主机关机请求会返回错误，不会假装关机成功。

### 添加到 Apple Home

1. 保存配置并重启 Homebridge，确认日志出现 `Published TV`。
2. 在 iPhone「家庭」App 点击 **添加配件 → 更多选项**，找到对应的电视名称。
3. 选择电视，输入该 Homebridge 桥的 HomeKit 配对码。若启用了子桥，使用所属子桥的配对码。
4. 每台主机分别添加一次。电视不会随着主桥配对自动出现在家庭 App。

这是 HomeKit TV 的外部配件发布方式，参见 [Homebridge 配对说明](https://github.com/homebridge/homebridge#adding-homebridge-to-ios)。已有电视的名称可在家庭 App 中修改；更换 MAC 会被视为新配件。删除主机配置后，还需在家庭 App 中手动移除旧电视。

### SSH 关机

`command` 在 **Homebridge 所在的系统或容器** 中执行，不在目标主机上直接执行。SSH、私钥、known_hosts 和权限必须为运行 Homebridge 的用户准备好。

- Linux：远程命令可用 `sudo -n /usr/sbin/shutdown -h now`。需确认实际路径，并仅给专用用户授予此关机命令的免密码 sudo 权限。
- macOS：远程命令可用 `sudo -n /sbin/shutdown -h now`，需要相应权限。
- Windows：启用并配置 OpenSSH Server 后，远程命令可用 `shutdown.exe /s /t 0`。具体账户权限和防火墙策略需按主机设置。

先以 Homebridge 运行用户验证 SSH 密钥登录、主机指纹和关机权限，再配置插件。程序必须无需交互并在 `shutdownTimeout` 内退出；长时间任务请让目标端接受请求后立即返回。SSH 在主机真正关闭前应返回成功；非零退出状态会被视为失败。

`args` 是逐项参数数组，不经过本地 Shell，不能直接使用管道、`&&`、`~` 或变量展开。最后一项 SSH 远程命令由远端 Shell 解释。不要把一整条 SSH 命令写进 `command`。需要复杂逻辑时可配置自己编写的可执行脚本的绝对路径。

### HTTP 关机

如果主机已有能接受关机请求的服务，可替换 `shutdown` 为：

```json
{
  "type": "http",
  "url": "http://192.168.1.100:8080/shutdown",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer REPLACE_WITH_YOUR_TOKEN",
    "Content-Type": "application/json"
  },
  "body": "{\"action\":\"shutdown\"}"
}
```

该接口需自行在目标主机提供。插件把 HTTP 2xx 视为已接受请求，不跟随重定向，不自动重试关机。支持 POST（默认）、PUT 和 GET；GET 不支持正文。配置文件内的令牌需要由 Homebridge 配置权限保护，插件日志不会输出请求头、正文或完整命令。

### TCP 状态探测

不允许 ICMP 时，指定一个主机开机后会接受连接的端口：

```json
{
  "name": "Windows 电脑",
  "mac": "AA:BB:CC:DD:EE:FF",
  "host": "192.168.1.101",
  "probe": "tcp",
  "statusPort": 3389
}
```

此片段仅演示探测配置；要控制关机，还需添加 `shutdown`。TCP 模式按指定服务可连接与否判断状态，服务停止或端口被防火墙阻挡也会显示为关机。Ping 的离线结果同样取决于 ICMP 可达性；主机名应可从 Homebridge 解析。

## 配置项

以下配置项放在每个 `devices[]` 对象中。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `name` | 必填 | TV 名称，最多 64 个字符 |
| `mac` | 必填 | 单播网卡 MAC，支持冒号、短横线或无分隔符 |
| `host` | 必填 | 状态探测 IP 或主机名 |
| `broadcastAddress` | `255.255.255.255` | IPv4 广播地址 |
| `interfaceAddress` | 自动 | Homebridge 的本机 IPv4，用于选择发送网卡 |
| `wolPort` | `9` | UDP 端口，1–65535 |
| `wolPackets` | `3` | Magic Packet 发送次数，1–10 |
| `wolInterval` | `100` | 重发间隔，0–250 毫秒 |
| `probe` | `ping` | `ping` 或 `tcp` |
| `statusPort` | TCP 模式必填 | TCP 检测端口，1–65535 |
| `pollInterval` | `5` | 每次探测完成后的间隔，1–3600 秒 |
| `probeTimeout` | `2000` | 单次探测超时，100–5000 毫秒 |
| `offlineThreshold` | `2` | 在线主机连续探测失败多少次后判为离线，1–10 |
| `onGracePeriod` | `90` | 开机状态等待窗口，0–600 秒 |
| `offGracePeriod` | `30` | 关机状态等待窗口，0–600 秒 |
| `shutdownTimeout` | `5000` | 关机操作超时，100–8000 毫秒 |
| `shutdown` | 无 | `command` 或 `http` 关机配置 |

命令被成功发送后，家庭 App 暂时显示目标状态；后台会继续探测，检测到目标状态后确认。如果等待窗口结束仍未达到目标状态，插件会记录日志并恢复检测到的状态。网络断开与真正关机都可能导致不可达，不能仅凭网络探测区分。探测程序缺失等执行错误则报告为配件无响应。

重复点击同一目标状态不会重复发送正在进行的命令；相反方向的请求在命令仍在发送时返回忙，发送结束后可以反向操作。插件关闭时会停止定时器并取消未完成的网络请求与子进程。

## WOL 排查

- 确认 BIOS/UEFI、操作系统和网卡驱动均启用了 WOL；部分设备只支持从睡眠唤醒。
- Windows 从关机唤醒时可能需要关闭快速启动；硬件、驱动和电源状态会影响实际效果。
- 默认广播通常只在当前二层网络生效。跨 VLAN／子网需要路由器允许定向广播或配置 WOL 中继。
- Docker 环境需确保广播能到达物理 LAN；Linux 常用 host 网络，其他环境需确认路由和广播转发能力。
- 插件发送 WOL 成功只表示 UDP 发送成功，不能保证主机已唤醒。请结合日志和状态探测结果确认。
- 本插件只实现主机电源控制，不提供视频播放、音量或遥控按键功能。

## 开发与验证

```sh
npm ci
npm run check
npm test
npm pack
```

测试使用 Node.js 自带测试框架，覆盖实际 UDP 包、TCP/Ping 探测、HTTP/命令关机、配置校验、电源状态转换及 Homebridge TV 发布。网络测试仅访问本机测试服务器，不会唤醒或关闭实际主机。
