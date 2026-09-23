#!/bin/zsh
# 调用 MM 远程入口: mmcall.sh <函数名> [JSON 参数数组]
# 依赖: ~/.clasprc.json (clasp 登录态)、~/.config/clasp/mm_remote_key
# 例:  mmcall.sh MM_status
#      mmcall.sh MM_calDump '[36]'
#      mmcall.sh MM_resyncTask '["T2026..."]'
#
# 已知现象: Web App 偶发在第二跳(script.googleusercontent.com)返回 Google 的 404 HTML
# 「Sorry, unable to open the file at this time」,与代码无关,重试即可。
# 注意: 服务端在第一次请求时可能已经执行完函数(见 docs/OPS.zh.md §8),
#      有副作用的函数(MM_plannerDaily / MM_adhocDriveDoc 等)依赖各步骤幂等。
set -e
FN="$1"; ARGS="${2:-[]}"
[[ -z "$FN" ]] && { echo "用法: mmcall.sh <函数名> [JSON 参数数组]" >&2; exit 2; }
DEPLOY_ID="PASTE_YOUR_WEB_APP_DEPLOYMENT_ID"   # 编辑器 → 部署 → 管理部署 → 复制 AKfycb... 开头的 ID
URL="https://script.google.com/macros/s/${DEPLOY_ID}/exec"
KEY=$(cat ~/.config/clasp/mm_remote_key)
MAX_TRIES="${MMCALL_RETRIES:-5}"   # 非 JSON 响应时的最大尝试次数
SLEEP_SEC="${MMCALL_SLEEP:-5}"

TOK=$(python3 - <<'EOF'
import json,os,urllib.request,urllib.parse
d=json.load(open(os.path.expanduser('~/.clasprc.json')))['tokens']['default']
body=urllib.parse.urlencode({'client_id':d['client_id'],'client_secret':d['client_secret'],'refresh_token':d['refresh_token'],'grant_type':'refresh_token'}).encode()
print(json.load(urllib.request.urlopen(urllib.request.Request('https://oauth2.googleapis.com/token',data=body)))['access_token'])
EOF
)

BODY=$(python3 -c 'import json,sys; print(json.dumps({"fn":sys.argv[1],"key":sys.argv[2],"args":json.loads(sys.argv[3])}))' "$FN" "$KEY" "$ARGS")

RAW=""
for (( i=1; i<=MAX_TRIES; i++ )); do
  RAW=$(curl -s -L --max-time 400 -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d "$BODY" "$URL" || true)
  case "$RAW" in
    \{*) break ;;                       # 拿到我们自己的 JSON
    *)   if (( i < MAX_TRIES )); then
           echo "(第 $i 次得到非 JSON 响应,${SLEEP_SEC}s 后重试)" >&2
           sleep "$SLEEP_SEC"
         fi ;;
  esac
done

print -r -- "$RAW" | python3 -c '
import json,sys
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception:
    print("非 JSON 响应(多次重试后仍失败;若是 HTML 登录页说明身份没过,见 docs/OPS.zh.md §8):")
    print(raw[:2000]); sys.exit(1)
print(("OK " if d.get("ok") else "FAIL ")+str(d.get("fn",""))+"  "+str(d.get("ms",""))+" ms")
for l in d.get("logs") or []: print("  "+l)
if d.get("error"): print("ERROR:",d["error"]); print(d.get("stack",""))
r=d.get("result")
if r is not None: print(r if isinstance(r,str) else json.dumps(r,ensure_ascii=False,indent=1))
sys.exit(0 if d.get("ok") else 1)
'
