# GitHub Actions Workflows

## Test Workflow

The `test.yml` workflow runs the VS Code extension test suite on multiple platforms.

### Behavior

- **All events**: Runs tests on Ubuntu, macOS, and Windows (full cross-platform coverage)
- **Manual trigger**: Can be manually triggered via `workflow_dispatch`
- Uses Node.js 20 (matches VS Code's Node version)

### Test Execution

- **Manual Git checkout**: Uses depth=1 shallow clone for faster checkout
- **Node.js setup**: Uses NVM on Linux/macOS, preinstalled Node on Windows
- **Dependencies**: Installs with `npm ci` (uses package-lock.json)
- **Linux**: Runs tests under `xvfb-run` (VS Code needs X server)
- **macOS/Windows**: Runs tests directly
- **Memory**: Sets `NODE_OPTIONS=--max_old_space_size=4096` for large test suites
- Downloads VS Code automatically via `@vscode/test-electron`
- Timeout: 15 minutes per platform

### Key Features

- **PR merge ref handling**: Properly checks out PR merge commits for accurate testing
- **Shallow clone**: Uses `--depth=1` for faster git operations
- **Build integration**: Build is handled by `npm pretest` (compile + lint)
- **Error handling**: Uploads test logs as artifacts on failure

### Artifacts

On test failure, logs are uploaded as artifacts:
- `test-output.log` - Full test output
- `.vscode-test/**/*.log` - VS Code test runner logs

Artifacts are retained for 7 days.

