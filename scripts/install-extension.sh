#!/bin/bash

# Script to install the extension to VS Code or Codex
set -e

EXTENSION_NAME="frontier-authentication"
VSIX_FILE="$EXTENSION_NAME-*.vsix"

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to find the latest VSIX file
find_latest_vsix() {
    latest_vsix=$(ls -t $EXTENSION_NAME-*.vsix 2>/dev/null | head -n1)
    if [ -z "$latest_vsix" ]; then
        echo "Error: No VSIX file found. Run 'npm run build-vsix' first."
        exit 1
    fi
    echo "$latest_vsix"
}

# Function to get VS Code extensions directory
get_vscode_extensions_dir() {
    case "$(uname -s)" in
        Darwin*) echo "$HOME/.vscode/extensions" ;;
        Linux*)  echo "$HOME/.vscode/extensions" ;;
        CYGWIN*|MINGW*|MSYS*) echo "$APPDATA/Code/User/extensions" ;;
        *) echo "$HOME/.vscode/extensions" ;;
    esac
}

# Function to get Codex extensions directory
get_codex_extensions_dir() {
    case "$(uname -s)" in
        Darwin*) echo "$HOME/.codex/extensions" ;;
        Linux*)  echo "$HOME/.codex/extensions" ;;
        CYGWIN*|MINGW*|MSYS*) echo "$APPDATA/Codex/User/extensions" ;;
        *) echo "$HOME/.codex/extensions" ;;
    esac
}

# Function to install extension via CLI (preferred method)
install_via_cli() {
    local cli_command="$1"
    local vsix_file="$2"
    
    echo "Installing via $cli_command..."
    if $cli_command --install-extension "$vsix_file" --force; then
        echo "✅ Extension installed successfully via $cli_command"
        return 0
    else
        echo "❌ Failed to install via $cli_command"
        return 1
    fi
}

# Function to manually extract and install extension
manual_install() {
    local extensions_dir="$1"
    local vsix_file="$2"
    local app_name="$3"
    
    echo "Manually installing to $app_name extensions directory: $extensions_dir"
    
    # Create extensions directory if it doesn't exist
    mkdir -p "$extensions_dir"
    
    # Create temporary directory for extraction
    temp_dir=$(mktemp -d)
    trap "rm -rf $temp_dir" EXIT
    
    # Extract VSIX file (it's a ZIP file)
    echo "Extracting $vsix_file..."
    unzip -q "$vsix_file" -d "$temp_dir"
    
    # Read package.json to get extension info
    if [ -f "$temp_dir/extension/package.json" ]; then
        publisher=$(node -p "require('$temp_dir/extension/package.json').publisher" 2>/dev/null || echo "unknown")
        name=$(node -p "require('$temp_dir/extension/package.json').name" 2>/dev/null || echo "$EXTENSION_NAME")
        version=$(node -p "require('$temp_dir/extension/package.json').version" 2>/dev/null || echo "0.0.1")
    else
        publisher="unknown"
        name="$EXTENSION_NAME"
        version="0.0.1"
    fi
    
    # Create extension directory
    extension_dir="$extensions_dir/${publisher}.${name}-${version}"
    
    # Remove existing version if it exists
    if [ -d "$extension_dir" ]; then
        echo "Removing existing extension: $extension_dir"
        rm -rf "$extension_dir"
    fi
    
    # Copy extension files
    echo "Installing extension to: $extension_dir"
    mkdir -p "$extension_dir"
    cp -r "$temp_dir/extension/"* "$extension_dir/"
    
    echo "✅ Extension manually installed to $app_name"
    echo "📁 Location: $extension_dir"
    echo "🔄 Restart $app_name to load the extension"
}

# Main installation logic
main() {
    echo "🔧 Installing Frontier Authentication Extension to Codex..."
    
    # Find the latest VSIX file
    vsix_file=$(find_latest_vsix)
    echo "📦 Using VSIX file: $vsix_file"
    
    # Check for Codex CLI
    codex_cli_available=false
    if command_exists codex; then
        echo "✅ Codex CLI found"
        codex_cli_available=true
    fi
    
    # Check for Codex extensions directory (even if CLI is not available)
    codex_extensions_dir=$(get_codex_extensions_dir)
    if [ -d "$codex_extensions_dir" ]; then
        echo "✅ Codex extensions directory found: $codex_extensions_dir"
        codex_directory_available=true
    else
        codex_directory_available=false
    fi
    
    # Fail if Codex is not found
    if [ "$codex_cli_available" = false ] && [ "$codex_directory_available" = false ]; then
        echo "❌ Codex not found on this system!"
        echo ""
        echo "Expected Codex extensions directory: $codex_extensions_dir"
        echo ""
        echo "Please ensure Codex is installed and either:"
        echo "  1. The 'codex' command is available in your PATH, or"
        echo "  2. The Codex extensions directory exists at the expected location"
        echo ""
        echo "If Codex is installed in a custom location, please create the extensions"
        echo "directory manually or add the Codex CLI to your PATH."
        exit 1
    fi
    
    # Install to Codex
    if [ "$codex_cli_available" = true ]; then
        if install_via_cli "codex" "$vsix_file"; then
            echo "🎉 Successfully installed to Codex via CLI"
        else
            echo "⚠️  CLI installation failed, trying manual installation to Codex"
            if [ "$codex_directory_available" = true ]; then
                manual_install "$codex_extensions_dir" "$vsix_file" "Codex"
            else
                echo "❌ Cannot fallback to manual installation - Codex extensions directory not found"
                exit 1
            fi
        fi
    else
        echo "⚠️  Codex CLI not available, installing manually to Codex extensions directory"
        manual_install "$codex_extensions_dir" "$vsix_file" "Codex"
    fi
    
    echo ""
    echo "🚀 Installation to Codex complete!"
    echo "📝 Please restart Codex to load the updated extension"
}

# Run the main function
main "$@"
