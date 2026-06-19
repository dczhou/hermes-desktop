#!/bin/bash
# 设置 npm 和 Electron 国内镜像

set -e

echo "配置 npm 镜像..."
npm config set registry https://registry.npmmirror.com

echo "创建 .npmrc 配置..."
cat > .npmrc << 'EOF'
registry=https://registry.npmmirror.com
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binary_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
EOF

echo "删除旧的 Electron..."
rm -rf node_modules/electron

echo "重新安装 Electron（使用镜像）..."
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install electron@39.2.6 --save-dev

echo "手动下载 Electron 二进制文件..."
cd node_modules/electron
curl -L -o dist/electron.zip "https://npmmirror.com/mirrors/electron/v39.2.6/electron-v39.2.6-linux-x64.zip"
cd dist
unzip -o electron.zip
echo "electron" > ../path.txt
cd ../..
rm -rf node_modules/electron/dist/electron.zip

echo ""
echo "✅ Electron 镜像设置完成！"
echo "运行 'npm install' 来安装其他依赖。"
echo "运行 'npm test' 来验证安装。"