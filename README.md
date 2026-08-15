# DeepSeek Harness 桌面版

把 deepseek-harness (https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 打包成桌面应用：
双击即可启动，无需在终端里敲 `dsh web` 命令。

## 特性

- 完全自包含：内置 Node 运行时 (vendor/node/node.exe) 与 DeepSeek Harness 及其全部依赖
  (vendor/dsh/)，无需预装 node / dsh / npm，双击即用。
- 系统托盘图标：科技感图标（深蓝圆角底 + 霓虹渐变描边 + 白鲸），常驻托盘，点击显示/隐藏窗口；右键弹出科技感自绘菜单（霓虹描边 + 呼吸状态灯 + 余额面板），提供「打开 / 在浏览器中打开 / 刷新余额 / 退出」。
- 托盘余额：托盘菜单实时显示 DeepSeek API 剩余余额（总余额 / 充值 / 赠送），每 30 秒自动刷新，也可点「刷新余额」手动更新；余额低于阈值（默认 ¥5，可用 DSH_BALANCE_LOW_THRESHOLD 调整）时托盘图标变红并弹出提醒。
- DeepSeek 过渡动画：启动时展示官方蓝色鲸鱼开屏（声呐涟漪 + 深海气泡 + 星光）；
  开屏无边框、原生拖动（无漂移）、可用鼠标拖动边缘自定义拉伸大小；右上角嵌有融入设计的圆形最小化按钮，
  点击最小化到任务栏（切换其他应用时也会自动最小化到任务栏）；服务就绪后主窗口以 650ms 缓动淡入（逐渐显现）。
- 自动端口：内部以 `dsh web --host 127.0.0.1 --port 0` 启动，由操作系统分配空闲端口，避免冲突。
- 单实例：重复启动只会唤起已有窗口。
- 关闭即隐藏：点窗口关闭按钮仅隐藏到托盘，退出请用托盘菜单「退出」。
- 主题跟随：在设置界面切换浅色 → 原生白色背景；切换深色 → 深海军蓝（#0b1536，与开屏背景一致）；窗口背景实时跟随界面主题。

## 运行原理

桌面壳（Electron 主进程）做的事情：

1. 定位运行时：优先使用内置的 vendor/node/node.exe 与 vendor/dsh 下的 dsh 入口；
   仅当内置运行时缺失时才回退到系统 dsh（开发调试用）。
2. 以子进程方式启动 `dsh web --host 127.0.0.1 --port 0`，并清除 NODE_PATH 以免泄漏宿主环境。
3. 显示开屏动画；监听 stdout 中的就绪行 `dsh web: http://127.0.0.1:<port>`。
4. 就绪后加载该 URL 到主窗口，淡入显示；整个过程中开屏负责过渡。

## 使用

### 绿色版（免安装，推荐）

    解压 release 下的 DeepSeek Harness 0.1.0-win.zip，
    然后双击其中的 DeepSeek Harness.exe 即可运行。

因为内置了 Node 运行时 + DeepSeek Harness 共约 500 MB，所以不做成单文件自解压 exe
（那种每次启动都要把 500MB 解压到临时目录，会出现「双击后半天没反应」）；
改用 zip 文件夹版：解压一次，之后直接双击运行，启动即时。

### 安装版

    运行 DeepSeek Harness Setup 0.1.0.exe 按向导安装，
    安装后从桌面 / 开始菜单快捷方式启动。

无需安装任何环境。用户数据（会话、配置、密钥）默认仍在用户主目录的 .dsh 下，
与命令行版 dsh 共用。

### 从源码运行 / 重新打包

    npm install
    npm start          # 开发运行
    npm run dist       # 重新打包 Windows 安装包 + 绿色版 zip

    打包前需先准备自包含运行时（vendor/ 不随源码仓库分发）：

        powershell -ExecutionPolicy Bypass -File scripts/prepare-vendor.ps1

    该脚本会生成：
      vendor/node/node.exe                                     （Node 运行时）
      vendor/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js      （dsh 入口 + 完整依赖树）
    前提：本机已安装 node 与 @deepseek-ai/dsh（npm install -g @deepseek-ai/dsh）。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| DSH_BIN | 显式指定 dsh 可执行文件（仅在内置运行时缺失时作为回退） |
| DSH_ROOT | 指定含 node_modules/@deepseek-ai/dsh 的目录（回退用） |

## 目录结构

    main.js            Electron 主进程（托盘 / 进程管理 / 窗口过渡）
    preload.js         开屏窗 preload（contextBridge 暴露 IPC）
    splash.html/css/js 开屏 + DeepSeek 过渡动画
    assets/            官方鲸鱼图标（icon.png / tray.png / whale.png）
    build/icon.ico     Windows 安装包图标
    vendor/node        Node 运行时（自包含）
    vendor/dsh         DeepSeek Harness + 全部依赖（自包含）
    scripts/           图标生成器（node scripts/make-official-icon.js）
