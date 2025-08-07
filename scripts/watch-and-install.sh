#!/bin/bash

# Script to watch for changes and automatically repackage and install the extension
set -e

EXTENSION_NAME="frontier-authentication"
WATCH_DIRS="src"

echo "🔄 Starting watch mode for Frontier Authentication Extension"
echo "📁 Watching directories: $WATCH_DIRS"
echo "🛑 Press Ctrl+C to stop"
echo ""

# Function to build and install
build_and_install() {
    echo "📦 Change detected! Building and installing extension..."
    echo "$(date): Starting build process"
    
    # Build the extension
    if npm run build-vsix; then
        echo "✅ Build successful"
        
        # Install the extension
        if ./scripts/install-extension.sh; then
            echo "🎉 Extension installed successfully at $(date)"
        else
            echo "❌ Extension installation failed at $(date)"
        fi
    else
        echo "❌ Build failed at $(date)"
    fi
    
    echo "👀 Watching for changes..."
    echo ""
}

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Stopping watch mode..."
    if [ ! -z "$FSWATCH_PID" ]; then
        kill $FSWATCH_PID 2>/dev/null || true
    fi
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Check if fswatch is available
if command -v fswatch >/dev/null 2>&1; then
    echo "✅ Using fswatch for file monitoring"
    
    # Initial build and install
    build_and_install
    
    # Watch for changes using fswatch
    fswatch -o $WATCH_DIRS | while read f; do
        build_and_install
    done &
    FSWATCH_PID=$!
    
    # Wait for the background process
    wait $FSWATCH_PID

elif command -v inotifywait >/dev/null 2>&1; then
    echo "✅ Using inotifywait for file monitoring"
    
    # Initial build and install
    build_and_install
    
    # Watch for changes using inotifywait (Linux)
    while inotifywait -r -e modify,create,delete $WATCH_DIRS; do
        build_and_install
    done

elif command -v entr >/dev/null 2>&1; then
    echo "✅ Using entr for file monitoring"
    
    # Initial build and install
    build_and_install
    
    # Watch for changes using entr
    find $WATCH_DIRS -name "*.ts" -o -name "*.js" -o -name "*.json" | entr -s 'echo "Change detected!"; npm run build-vsix && ./scripts/install-extension.sh'

else
    echo "❌ No file watching utility found!"
    echo ""
    echo "Please install one of the following:"
    echo "  macOS: brew install fswatch"
    echo "  Linux: sudo apt-get install inotify-tools (for inotifywait)"
    echo "  Cross-platform: brew install entr (or equivalent package manager)"
    echo ""
    echo "Falling back to simple polling mode (checks every 5 seconds)..."
    echo ""
    
    # Simple polling fallback
    last_hash=""
    
    # Initial build and install
    build_and_install
    
    while true; do
        # Calculate hash of all TypeScript files
        current_hash=$(find $WATCH_DIRS -name "*.ts" -o -name "*.js" -o -name "*.json" -type f -exec md5sum {} \; 2>/dev/null | md5sum 2>/dev/null || echo "")
        
        if [ "$current_hash" != "$last_hash" ] && [ ! -z "$last_hash" ]; then
            build_and_install
        fi
        
        last_hash="$current_hash"
        sleep 5
    done
fi
