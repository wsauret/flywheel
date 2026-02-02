#!/bin/bash

# Flywheel Plugin Installer
# Installs the plugin and configures Context7 MCP with your API key

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "================================"
echo "  Flywheel Plugin Installer"
echo "================================"
echo ""

# Step 1: Add the local marketplace
echo "Step 1: Adding marketplace..."
claude plugin marketplace remove local-marketplace > /dev/null 2>&1 || true
claude plugin marketplace add "$SCRIPT_DIR/local-marketplace" > /dev/null
echo "  ✓ Marketplace added"

# Step 2: Install the plugin
echo "Step 2: Installing plugin..."
claude plugin install flywheel@local-marketplace > /dev/null
echo "  ✓ Plugin installed"

# Step 3: Configure Context7 API key
echo "Step 3: Configuring Context7..."

# Determine shell profile file
get_shell_profile() {
    if [ -n "$ZSH_VERSION" ] || [ "$SHELL" = "/bin/zsh" ]; then
        echo "$HOME/.zshrc"
    elif [ -n "$BASH_VERSION" ] || [ "$SHELL" = "/bin/bash" ]; then
        if [ -f "$HOME/.bash_profile" ]; then
            echo "$HOME/.bash_profile"
        else
            echo "$HOME/.bashrc"
        fi
    else
        echo "$HOME/.profile"
    fi
}

# Check if CONTEXT7_API_KEY env var is already set
if [ -n "$CONTEXT7_API_KEY" ]; then
    echo "  * Found CONTEXT7_API_KEY in environment, using it..."
    API_KEY="$CONTEXT7_API_KEY"
    SAVE_TO_PROFILE=false
else
    echo "  * Context7 provides up-to-date framework documentation for the planning workflow."
    read -p "  * Enter your Context7 API key (or press Enter to skip): " API_KEY
    SAVE_TO_PROFILE=true
fi

if [ -n "$API_KEY" ]; then

    # Remove existing context7 config if present
    claude mcp remove context7 > /dev/null 2>&1 || true

    # Add with the API key header
    claude mcp add --header "CONTEXT7_API_KEY: $API_KEY" --transport http context7 https://mcp.context7.com/mcp > /dev/null

    echo "  ✓ Context7 configured with your API key"

    # Offer to save API key to shell profile for future installs
    if [ "$SAVE_TO_PROFILE" = true ]; then
        PROFILE_FILE=$(get_shell_profile)
        read -p "  * Save API key to $PROFILE_FILE for future installs? [Y/n]: " SAVE_CHOICE
        SAVE_CHOICE=${SAVE_CHOICE:-Y}

        if [[ "$SAVE_CHOICE" =~ ^[Yy]$ ]]; then
            # Check if already in profile (avoid duplicates)
            if grep -q "export CONTEXT7_API_KEY=" "$PROFILE_FILE" 2>/dev/null; then
                # Update existing entry
                sed -i.bak "s|^export CONTEXT7_API_KEY=.*|export CONTEXT7_API_KEY=\"$API_KEY\"|" "$PROFILE_FILE"
                rm -f "${PROFILE_FILE}.bak"
                echo "  ✓ Updated CONTEXT7_API_KEY in $PROFILE_FILE"
            else
                # Add new entry
                echo "" >> "$PROFILE_FILE"
                echo "# Context7 API key for Flywheel plugin" >> "$PROFILE_FILE"
                echo "export CONTEXT7_API_KEY=\"$API_KEY\"" >> "$PROFILE_FILE"
                echo "  ✓ Added CONTEXT7_API_KEY to $PROFILE_FILE"
            fi
            echo "  * Restart your terminal to use this variable in future sessions."
        fi
    fi
else
    echo "  * Skipped Context7 configuration"
fi

echo "Installation Complete!"
