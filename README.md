# Water-Reminder

## Windows Build Instructions

### Prerequisites

1. Install [Node.js](https://nodejs.org/).
2. Install [Rust](https://www.rust-lang.org/) using the official installer.
3. Install [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
4. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and include the C++ build tools workload.

### Build Steps

Run the following commands from the project root:

```bash
git clone https://github.com/DrDrrae/Water-Reminder.git
cd Water-Reminder
npm install
npm run build
npm run tauri build
