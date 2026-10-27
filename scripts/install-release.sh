#!/bin/sh
set -eu

repository="benjamin-qhy/qiushui-airadar"
old_root="$HOME/.airadar"
previous_root="$HOME/.qiushuiai-airadar"
new_root="$HOME/.qiushui-airadar"
program_root="$new_root/program"
production_data_root="$new_root/production-data"
port="${QIUSHUI_AIRADAR_PORT:-${QIUSHUIAI_AIRADAR_PORT:-43120}}"
bind_host="${QIUSHUI_AIRADAR_HOST:-0.0.0.0}"

find_node_24() {
  for candidate in \
    /opt/homebrew/opt/node@24/bin/node \
    /usr/local/opt/node@24/bin/node \
    "$(command -v node 2>/dev/null || true)"
  do
    if [ -x "$candidate" ] && [ "$("$candidate" -p 'process.versions.node.split(`.`)[0]' 2>/dev/null || true)" = "24" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

node_executable="$(find_node_24 || true)"
if [ -z "$node_executable" ]; then
  echo "未找到 Node.js 24。请先安装：brew install node@24，然后重新运行本安装命令。" >&2
  exit 1
fi
node_bin="$(dirname "$node_executable")"
PATH="$node_bin:$PATH"
export PATH

command -v curl >/dev/null 2>&1 || { echo "缺少 curl" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Node.js 24 不完整：缺少 npm，请重新安装 Node.js 24" >&2; exit 1; }

node_version="$("$node_executable" -p 'process.versions.node')"
node_major="${node_version%%.*}"
if [ "$node_major" != "24" ]; then
  echo "需要 Node.js 24，当前是 $node_version" >&2
  exit 1
fi

configure_shell_path() {
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh) shell_config="$HOME/.zshrc" ;;
    bash)
      if [ "$(uname -s)" = "Darwin" ]; then
        shell_config="$HOME/.bash_profile"
      else
        shell_config="$HOME/.bashrc"
      fi
      ;;
    *)
      if [ "$(uname -s)" = "Darwin" ]; then
        shell_config="$HOME/.zshrc"
      else
        shell_config="$HOME/.profile"
      fi
      ;;
  esac

  if [ -f "$shell_config" ] && grep -F '# >>> qiushuiai-airadar installer >>>' "$shell_config" >/dev/null 2>&1; then
    cp -p "$shell_config" "$shell_config.before-qiushui-airadar"
    node - "$shell_config" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const original = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, original.replace(/^# >>> qiushuiai-airadar installer >>>\r?\n[\s\S]*?^# <<< qiushuiai-airadar installer <<<\r?\n?/gm, ''));
NODE
  fi
  marker="# >>> qiushui-airadar installer >>>"
  if [ -f "$shell_config" ] && grep -F "$marker" "$shell_config" >/dev/null 2>&1; then
    printf '%s\n' "$shell_config"
    return 0
  fi

  mkdir -p "$(dirname "$shell_config")"
  if [ -s "$shell_config" ]; then printf '\n' >> "$shell_config"; fi
  escaped_node_bin="$(printf '%s' "$node_bin" | sed "s/'/'\\\\''/g")"
  {
    printf '%s\n' "$marker"
    printf "export PATH='%s':\"\$HOME/.qiushui-airadar/program/bin:\$PATH\"\n" "$escaped_node_bin"
    printf '%s\n' "# <<< qiushui-airadar installer <<<"
  } >> "$shell_config"
  printf '%s\n' "$shell_config"
}

if [ "${1:-}" = "--configure-path-only" ]; then
  shell_config="$(configure_shell_path)"
  echo "命令环境已配置：$shell_config"
  echo "请关闭并重新打开终端。"
  exit 0
fi

temporary="$(mktemp -d "${TMPDIR:-/tmp}/qiushui-airadar-install.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

release_json="$temporary/qiushui-airadar-release.json"
curl -fsSL \
  "https://github.com/$repository/releases/latest/download/qiushui-airadar-release.json" \
  -o "$release_json"
version="$(node -e "const r=require(process.argv[1]); const v=String(r.version||''); if(!/^\\d+\\.\\d+\\.\\d+$/.test(v)||r.package!=='qiushui-airadar-cli-'+v+'.tgz'||r.checksum!==r.package+'.sha256') process.exit(1); process.stdout.write(v)" "$release_json")"
package="qiushui-airadar-cli-$version.tgz"
base="https://github.com/$repository/releases/download/v$version"

curl -fL "$base/$package" -o "$temporary/$package"
curl -fL "$base/$package.sha256" -o "$temporary/$package.sha256"
(cd "$temporary" && shasum -a 256 -c "$package.sha256")

if [ -e "$previous_root" ]; then
  if [ -e "$old_root" ] || [ -e "$new_root" ]; then
    echo "迁移已停止：新旧安装目录同时存在，请先人工确认数据。" >&2
    exit 1
  fi
  old_root="$previous_root"
fi
if [ -e "$old_root" ] && [ -e "$new_root" ]; then
  echo "迁移已停止：$old_root 和 $new_root 同时存在，请先人工确认数据。" >&2
  exit 1
fi

# Resolve dependencies before stopping the running service.
npm install -g --prefix "$temporary/program" --ignore-scripts --no-audit --no-fund "$temporary/$package"

# Stop every service name used by released predecessors before moving data.
for cli in \
  "$old_root/installed-program/bin/airadar" \
  "$old_root/program/bin/qiushuiai-airadar" \
  "$new_root/installed-program/bin/airadar" \
  "$new_root/program/bin/qiushui-airadar"
do
  if [ -x "$cli" ]; then "$cli" service stop >/dev/null 2>&1 || true; fi
done
if [ "$(uname -s)" = "Darwin" ]; then
  uid="$(id -u)"
  for label in ai.qiushuiai.airadar-installed ai.qiushuiai.airadar-v2 ai.qiushui.qiushui-airadar-installed ai.qiushuiai.qiushuiai-airadar ai.qiushuiai.qiushuiai-airadar-installed; do
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
  done
fi

if [ -d "$old_root" ]; then
  mv "$old_root" "$new_root"
  echo "已迁移 $old_root -> $new_root"
fi

mkdir -p "$new_root/backups"
chmod 700 "$new_root" "$new_root/backups"
stamp="$(date +%Y%m%d-%H%M%S)-$$"
if [ "$(uname -s)" = "Darwin" ]; then
  for plist in \
    "$HOME/Library/LaunchAgents/ai.qiushuiai.airadar-installed.plist" \
    "$HOME/Library/LaunchAgents/ai.qiushuiai.airadar-v2.plist" \
    "$HOME/Library/LaunchAgents/ai.qiushui.qiushui-airadar-installed.plist" \
    "$HOME/Library/LaunchAgents/ai.qiushuiai.qiushuiai-airadar.plist" \
    "$HOME/Library/LaunchAgents/ai.qiushuiai.qiushuiai-airadar-installed.plist"
  do
    if [ -f "$plist" ]; then
      name="$(basename "$plist")"
      mv "$plist" "$new_root/backups/legacy-$stamp-$name"
    fi
  done
fi

move_legacy_directory() {
  source="$1"
  target="$2"
  if [ ! -e "$source" ]; then return; fi
  if [ -e "$target" ]; then
    echo "迁移已停止：$source 和 $target 同时存在，请先人工确认数据。" >&2
    exit 1
  fi
  mv "$source" "$target"
}

# The active development service used single-table-data. dev-data is an older
# snapshot and is retained separately when both exist.
if [ -d "$new_root/single-table-data" ]; then
  move_legacy_directory "$new_root/single-table-data" "$new_root/development-data"
elif [ -d "$new_root/dev-data" ]; then
  move_legacy_directory "$new_root/dev-data" "$new_root/development-data"
fi
if [ -d "$new_root/dev-data" ]; then
  mv "$new_root/dev-data" "$new_root/backups/legacy-development-data-$stamp"
fi

move_legacy_directory "$new_root/installed-data" "$production_data_root"

if [ -d "$production_data_root" ]; then
  backup="$new_root/backups/$stamp-before-$version"
  mkdir -p "$backup"
  cp -R "$production_data_root" "$backup/production-data"
  echo "正式数据备份：$backup"
fi


rename_legacy_database() {
  data_root="$1"
  legacy_database="$data_root/qiushuiai-airadar.sqlite"
  if [ ! -f "$legacy_database" ]; then legacy_database="$data_root/airadar.sqlite"; fi
  if [ ! -f "$legacy_database" ]; then return; fi
  if [ -f "$data_root/airadar.sqlite" ] && [ -f "$data_root/qiushuiai-airadar.sqlite" ]; then
    echo "迁移已停止：同一目录存在两个旧数据库，请先人工确认。" >&2
    exit 1
  fi
  if [ -e "$data_root/qiushui-airadar.sqlite" ]; then
    echo "迁移已停止：$data_root 中同时存在新旧数据库，请先人工确认数据。" >&2
    exit 1
  fi
  for suffix in "" "-shm" "-wal"; do
    if [ -e "$legacy_database$suffix" ]; then
      mv "$legacy_database$suffix" "$data_root/qiushui-airadar.sqlite$suffix"
    fi
  done
}
rename_legacy_database "$new_root/development-data"
rename_legacy_database "$production_data_root"

# Preserve earlier program/service directories before assigning the canonical
# names to the currently installed release.
if [ -d "$new_root/installed-program" ]; then
  if [ -e "$program_root" ]; then
    mv "$program_root" "$new_root/backups/legacy-program-$stamp"
  fi
  mv "$new_root/installed-program" "$program_root"
fi
if [ -d "$new_root/installed-service" ]; then
  if [ -e "$new_root/service" ]; then
    mv "$new_root/service" "$new_root/backups/legacy-service-$stamp"
  fi
  mv "$new_root/installed-service" "$new_root/service"
fi


if [ -d "$program_root" ]; then
  mv "$program_root" "$new_root/backups/program-$stamp-before-$version"
fi
mv "$temporary/program" "$program_root"
cli="$program_root/bin/qiushui-airadar"
"$cli" service install --host "$bind_host" --port "$port"
installed_version="$("$cli" --version)"
if [ "$installed_version" != "$version" ]; then
  echo "版本校验失败：期望 $version，实际 $installed_version" >&2
  exit 1
fi
curl --noproxy '*' --retry 10 --retry-connrefused --retry-delay 1 -fsS \
  "http://127.0.0.1:$port/health" >/dev/null
shell_config="$(configure_shell_path)"
echo "qiushui-airadar $version 已安装并运行：http://127.0.0.1:$port"
echo "命令环境已自动配置：$shell_config（重新打开终端后生效）"
if [ "$(uname -s)" = "Darwin" ] && [ "${QIUSHUI_AIRADAR_OPEN_BROWSER:-1}" = "1" ]; then
  open "http://127.0.0.1:$port" >/dev/null 2>&1 || true
fi
