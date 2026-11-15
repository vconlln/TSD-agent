#!/usr/bin/env bash
# 生成一套「内部 CA + 代码签名证书」，用来给 TSD Agent 安装包签名。
#
#   bash scripts/gen-signing-cert.sh --org "某某公司" --cn "某某公司 软件发布" --out ./signing
#
# 产出（都在 --out 目录里）：
#   root.crt / root.cer   根证书（cer 给 Windows 双击安装用）
#   root.key              根证书私钥（离线保管，别提交、别放构建机共享目录）
#   sign.crt / sign.key   发布证书（代码签名用途）
#   sign.pfx              签名用的打包文件（含私钥 + 根证书链）
#   install-root.ps1      客户机管理员一键装根证书
#   verify.ps1            客户机校验安装包签名
#
# 说明：根证书私钥只在这一步用到，签安装包只需要 sign.pfx。
set -euo pipefail

OUT="./signing"
ORG="Example Company"
CN="TSD Agent Publisher"
PASS=""
DAYS_ROOT=7300
DAYS_LEAF=730

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --cn) CN="$2"; shift 2 ;;
    --password) PASS="$2"; shift 2 ;;
    --days) DAYS_LEAF="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

if ! command -v openssl >/dev/null 2>&1; then
  echo "需要 openssl：Debian/Ubuntu 用 apt install openssl，Arch 自带" >&2
  exit 1
fi

case "$CN" in
  *[!\ -~]*) echo "提示：证书 CN 建议用英文——Windows 上它是显示的发布者名字，老签名工具对中文支持差" >&2 ;;
esac

if [[ -z "$PASS" ]]; then
  PASS="$(openssl rand -base64 18 | tr -d '\n/+=' | cut -c1-18)"
  GENERATED_PASS=1
else
  GENERATED_PASS=0
fi

mkdir -p "$OUT"
cd "$OUT"

echo "▸ 1/4 根证书（内部 CA，$DAYS_ROOT 天）"
openssl req -x509 -newkey rsa:4096 -sha256 -days "$DAYS_ROOT" -nodes \
  -keyout root.key -out root.crt \
  -subj "/CN=$ORG Code Signing Root/O=$ORG/C=CN" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign,digitalSignature" >/dev/null 2>&1

echo "▸ 2/4 发布证书（代码签名用途，$DAYS_LEAF 天）"
openssl req -newkey rsa:3072 -sha256 -nodes -keyout sign.key -out sign.csr \
  -subj "/CN=$CN/O=$ORG/C=CN" >/dev/null 2>&1

cat > ext.cnf <<'EXTEOF'
keyUsage=critical,digitalSignature
extendedKeyUsage=codeSigning
basicConstraints=critical,CA:FALSE
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EXTEOF

openssl x509 -req -in sign.csr -CA root.crt -CAkey root.key -CAcreateserial \
  -days "$DAYS_LEAF" -sha256 -extfile ext.cnf -out sign.crt >/dev/null 2>&1

echo "▸ 3/4 打包成 pfx（签名用）"
openssl pkcs12 -export -out sign.pfx -inkey sign.key -in sign.crt \
  -certfile root.crt -passout "pass:$PASS"

echo "▸ 4/4 生成客户机脚本"
openssl x509 -in root.crt -outform DER -out root.cer

cat > install-root.ps1 <<'PSEOF'
# 以管理员身份运行：把内部根证书装进「受信任的根证书颁发机构」+「受信任的发布者」
$root = Join-Path $PSScriptRoot 'root.cer'
Import-Certificate -FilePath $root -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Import-Certificate -FilePath $root -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
Write-Host "根证书已安装：装过之后内部签名的 TSD Agent 安装包不会再提示未知发布者" -ForegroundColor Green
PSEOF

cat > verify.ps1 <<'PSEOF'
# 校验安装包签名：Status 应为 Valid，SignerCertificate.Subject 应是你公司名
param([string]$File = "TSD-Agent-Setup-1.3.0.exe")
$sig = Get-AuthenticodeSignature $File
$sig | Format-List Status, StatusMessage
Write-Host ("签名者：" + $sig.SignerCertificate.Subject)
Write-Host ("时间戳：" + $sig.TimeStamperCertificate.Subject)
PSEOF

rm -f sign.csr ext.cnf

echo ""
echo "完成。产物在：$(pwd)"
echo "  根证书        root.crt / root.cer（cer 用于客户机安装）"
echo "  根私钥        root.key（离线保管，签完就不用动它）"
echo "  发布证书      sign.crt / sign.key"
echo "  签名包        sign.pfx"
if [[ "$GENERATED_PASS" == "1" ]]; then
  echo "  pfx 密码      $PASS   ← 记下来，签名时要填"
fi
echo ""
echo "下一步："
echo "  1) 客户机（管理员 PowerShell）跑 install-root.ps1 装根证书；"
echo "     有域环境就直接用组策略推 root.cer 到「受信任的根证书颁发机构」"
echo "  2) 回仓库根目录签名打包："
echo "       export WIN_CSC_LINK=$(pwd)/sign.pfx"
echo "       export WIN_CSC_KEY_PASSWORD=<上面的密码>"
echo "       npm run dist:installer -- --target win --require-signature"
echo "  3) 用 verify.ps1 校验产物（或 signtool verify /pa /v）"
