#!/bin/sh
set -eu

label="com.codexcommander.inmo.bridge"
plist="$HOME/Library/LaunchAgents/$label.plist"
service_target="gui/$(id -u)/$label"

if launchctl print "$service_target" >/dev/null 2>&1; then
  launchctl bootout "$service_target"
fi

if [ -f "$plist" ]; then
  rm -f -- "$plist"
  echo "已移除 CodeX Commander 登录服务；本机 .env、配对状态和日志仍保留"
else
  echo "CodeX Commander 登录服务未安装"
fi
