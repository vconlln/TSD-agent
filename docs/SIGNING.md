# Windows 代码签名指南

> 目标：让 TSD-Agent-Setup-*.exe 双击时不弹 SmartScreen「未知发布者」。
> 按「花多少钱 / 多麻烦」排序，第四节是本项目已经接好的命令。

---

## 0. 先看结论

| 你的场景 | 走哪条 | 成本 | 客户机上的效果 |
| --- | --- | --- | --- |
| **公司内网分发（推荐）** | 公司内部 CA（AD CS）自签 + 组策略推根证书 | **0 元** | 域内机器**零提示** |
| 公开下载，想自动化 | Azure Trusted Signing（云签名） | 约 $10/月 | 新证书要攒几天信誉，可能先提示 |
| 公开下载，要立刻可信 | EV 代码签名证书 | 3000–8000 元/年 | **立即**通过，无需攒信誉 |
| 只给自己或几个人 | 自签证书 + 手动装一次证书 | 0 元 | 装过根证书的机器不提示 |

一句话：**内网工具就自己建 CA，不用花钱买证书**；要对外分发才考虑 EV / Azure。

---

## 1. 2023 年之后的硬规矩

CA/Browser Forum 从 2023-06 起强制要求：**公开信任的代码签名证书，私钥必须存放在
硬件 token 或云 HSM 里，不再允许导出 pfx 文件。**

实际影响：

- 「买张证书，拿到 pfx，随便哪台机器签」这条路**已经没有了**；
- 传统证书到手是 USB Token（SafeNet eToken / YubiKey）或云 HSM（DigiCert KeyLocker、Sectigo 云签名）；
- 所以**签名机器必须能访问 token 或云 HSM 的 API**，这让「在 Linux 构建机上签名」变麻烦；
- 例外：**公司自己的内部 CA 不受此限制**，pfx 随便导出，这也是内网方案最舒服的原因。

---

## 2. 方案 A：公司内部 CA（内网分发最优解，0 元）

### 2.1 有域环境

1. 在服务器上装 **AD CS**（证书颁发机构）；
2. 复制「代码签名」模板，新建模板，用途设为 Code Signing，发布给发布者账号；
3. 申请证书，导出**含私钥的 pfx**；
4. **最关键一步**：把内部根证书用组策略（GPO）或 Intune 推到所有客户机的
   「受信任的根证书颁发机构」+「受信任的发布者」。

组策略路径：`计算机配置 -> 策略 -> Windows 设置 -> 安全设置 -> 公钥策略 -> 受信任的根证书颁发机构`

### 2.2 没有域环境（openssl 自签，适合小范围）

```bash
# 1) 根证书（20 年）
openssl req -x509 -newkey rsa:4096 -sha256 -days 7300 -nodes \
  -keyout root.key -out root.crt \
  -subj "/CN=某某公司内部代码签名根/O=某某公司/C=CN" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

# 2) 发布证书（代码签名用途，2 年）
openssl req -newkey rsa:2048 -sha256 -nodes -keyout sign.key -out sign.csr \
  -subj "/CN=某某公司 TSD Agent/O=某某公司/C=CN"
openssl x509 -req -in sign.csr -CA root.crt -CAkey root.key -CAcreateserial \
  -days 730 -sha256 -out sign.crt \
  -extfile <(printf "keyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning")

# 3) 打包成 pfx（签名用这个）
openssl pkcs12 -export -out sign.pfx -inkey sign.key -in sign.crt \
  -certfile root.crt -passout pass:你的密码
```

每台客户机上装一次根证书（管理员 PowerShell）：

```powershell
Import-Certificate -FilePath root.crt -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath root.crt -CertStoreLocation Cert:\LocalMachine\TrustedPeople
```

做完这些，签过名的 exe 在这些机器上双击**不再**提示未知发布者。

### 2.3 签名命令

Windows：

```powershell
signtool sign /fd SHA256 /f sign.pfx /p 你的密码 /tr http://timestamp.digicert.com /td SHA256 "TSD-Agent-Setup-1.3.0.exe"
signtool verify /pa /v "TSD-Agent-Setup-1.3.0.exe"
```

Linux（osslsigncode）：

```bash
osslsigncode sign -pkcs12 sign.pfx -pass 你的密码 \
  -n "TSD Agent" -i https://github.com/vconlln/TSD-agent \
  -h sha256 -t http://timestamp.digicert.com \
  -in unsigned.exe -out signed.exe
```

---

## 3. 方案 B：Azure Trusted Signing（能在 Linux 上全自动化的公开证书）

微软自家的云签名服务，2024 GA，**不需要硬件 token**，走 API 签。

- 价格：约 **$9.99/月**
- 资格：组织需 **3 年以上可验证注册历史**；个人开发者目前限美国/加拿大
- 流程：Azure 订阅 -> 注册 Trusted Signing 资源 -> 建「证书配置文件」-> 用 Entra ID 服务主体鉴权

跨平台签名（Linux 构建机可用）：

```bash
dotnet tool install --global TrustedSigning.Client

export AZURE_TENANT_ID=...
export AZURE_CLIENT_ID=...
export AZURE_CLIENT_SECRET=...

trusted-signing-cli \
  -e https://neu.codesigning.azure.net/ \
  -a 你的账号名 -c 证书配置文件名 \
  -d "TSD Agent" \
  待签文件.exe
```

Windows 上也支持（win.azureSignOptions），但它内部用 PowerShell 的 Invoke-TrustedSigning，只能在 Windows 跑。

**注意**：Trusted Signing 走微软自家信任链，信誉建立比 EV 慢、比 OV 快；
新发布者名头几天仍可能提示，需要自己实测，别信「包过」说法。

---

## 4. 方案 C：传统 OV / EV 证书

| 项 | OV（组织验证） | EV（扩展验证） |
| --- | --- | --- |
| 价格 | 1000–3000 元/年 | 3000–8000 元/年 |
| 材料 | 营业执照、法人证件、企业电话验证、邓白氏编码 | 同 OV + 公司成立满 3 年证明 |
| 交付 | USB Token 或云 HSM | USB Token 或云 HSM |
| SmartScreen | **需要攒信誉**（下载量 + 时间），新证书照样提示 | **立即通过** |
| 适用 | 有耐心等信誉的公开分发 | 面向外部客户、要求零提示 |

国内渠道：DigiCert / GlobalSign / Sectigo 代理、沃通、CFCA、天威诚信。
买之前问清三件事：**是否支持云 HSM API**（决定能否自动化）、
**是否支持 SHA-256 + RFC3161 时间戳**、**换证是否要重新验证**。

---

## 5. 本项目怎么接（已实现，不改代码）

构建脚本 `scripts/build-installer.mjs` 支持两种签名方式。

### 5.1 有 pfx（内部 CA 或云 HSM 导出的文件）

```bash
export WIN_CSC_LINK=/绝对路径/sign.pfx
export WIN_CSC_KEY_PASSWORD=你的密码

npm run dist:installer -- --target win --require-signature
```

脚本会自动：

| 步骤 | 说明 |
| --- | --- |
| 打印签名模式 | 构建一开始就说清楚走 pfx / Azure / 外部命令 / 未签名 |
| 签内置后端 | resources/backend/.../tsd-server.exe 也会被签 |
| 签主程序 + 卸载器 | TSD Agent.exe、TSD-Agent-Setup-*.exe、uninstaller |
| 自检签名 | 构建结束逐个读 PE 头，打印「已签名 / 未签名」 |
| --require-signature | 没签上就**构建失败**，不会悄悄产出未签名包 |

Linux 构建机的坑：electron-builder 自带的 osslsigncode 是 2020 年编译的，依赖
`libcrypto.so.1.1`；新发行版只剩 OpenSSL 3。构建脚本会自动在系统里找 1.1
（很多机器被 Steam / 旧运行时带着）并临时挂到 `LD_LIBRARY_PATH`；找不到就用 5.2 的方式。

### 5.2 用外部签名命令（云 HSM、Azure、企业签名服务）

```bash
export TSD_SIGN_CMD='trusted-signing-cli -e https://neu.codesigning.azure.net/ -a acct -c profile -d "TSD Agent" {file}'

npm run dist:installer -- --target win --require-signature
```

- `{file}` 会替换成待签文件路径；
- 顺序：先签内置后端 exe -> electron-builder 打包 -> 最后签安装包本体；
- 每一步签完都校验 PE 里确实有签名块，签失败立即中断。

### 5.3 验证签好了没

```bash
signtool verify /pa /v release\TSD-Agent-Setup-1.3.0.exe     # Windows
osslsigncode verify -in release/TSD-Agent-Setup-1.3.0.exe    # Linux
```

构建日志末尾也会逐个打印产物的签名状态。

---

## 6. 时间戳不是可选项

签名必须带**时间戳**，否则证书一到期，之前签的所有安装包全部失效。
示例都带了 `/tr http://timestamp.digicert.com /td SHA256`（RFC 3161）；
electron-builder 的 `rfc3161TimeStampServer` 默认已指向 DigiCert。
建议再加个备用源（http://timestamp.sectigo.com），DigiCert 偶尔抽风。

---

## 7. 验证到什么程度（别把预期调太高）

已实测：

- 用 openssl 生成的自签证书跑通**完整签名链路**：内置后端 exe、主程序、安装包全部签上，
  PE 里有 14KB 签名块，Wine 里冒烟自检仍然通过；
- `--require-signature` 能拦住「没签上」的情况（构建失败，而不是悄悄产出未签名包）。

**没有**验证到：

- 真实证书在真实 Windows 上的免提示效果——取决于证书类型（EV / OV / 内部 CA）、
  根证书是否已装到客户机、以及 SmartScreen 信誉，只能拿真证书实测；
- Azure Trusted Signing 的真实签发（需要你的 Azure 订阅与资格）。

---

## 8. 给你的建议

你们这是**内网 Agent 工具**，最划算的路径：

1. 用内部 CA 签一张代码签名证书（0 元，几十秒）；
2. 通过组策略把根证书推到所有客户机（一次性）；
3. 用 `WIN_CSC_LINK` + `--require-signature` 打包，签完直接发。

域内安装**零提示**，不用每年续费，也不用碰硬件 token。
将来要给外部客户装，再补一张 EV（要立即可信）或 Azure Trusted Signing（要自动化）。
