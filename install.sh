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
claude plugin marketplace remove local-marketplace 2>/dev/null || true
claude plugin marketplace add "$SCRIPT_DIR/local-marketplace"
echo "  ✓ Marketplace added"

# Step 2: Install the plugin
echo ""
echo "Step 2: Installing plugin..."
claude plugin install flywheel@local-marketplace
echo "  ✓ Plugin installed"

# Step 3: Configure Context7 API key
echo ""
echo "Step 3: Configure Context7 (optional but recommended)"
echo ""

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
    echo "Found CONTEXT7_API_KEY in environment, using it..."
    API_KEY="$CONTEXT7_API_KEY"
    SAVE_TO_PROFILE=false
else
    echo "Context7 provides up-to-date framework documentation for the planning workflow."
    echo "Get a free API key at: https://context7.com/dashboard"
    echo ""
    read -p "Enter your Context7 API key (or press Enter to skip): " API_KEY
    SAVE_TO_PROFILE=true
fi

if [ -n "$API_KEY" ]; then
    echo ""
    echo "Configuring Context7 MCP server..."

    # Remove existing context7 config if present
    claude mcp remove context7 2>/dev/null || true

    # Add with the API key header
    claude mcp add --header "CONTEXT7_API_KEY: $API_KEY" --transport http context7 https://mcp.context7.com/mcp

    echo "  ✓ Context7 configured with your API key"

    # Offer to save API key to shell profile for future installs
    if [ "$SAVE_TO_PROFILE" = true ]; then
        PROFILE_FILE=$(get_shell_profile)
        echo ""
        read -p "Save API key to $PROFILE_FILE for future installs? [Y/n]: " SAVE_CHOICE
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
            echo "  → Run 'source $PROFILE_FILE' or restart your terminal to use it"
        fi
    fi
else
    echo ""
    echo "  → Skipped Context7 configuration"
    echo "  → You can add it later with:"
    echo "    claude mcp add --header \"CONTEXT7_API_KEY: YOUR_KEY\" --transport http context7 https://mcp.context7.com/mcp"
fi

echo ""
echo "================================"
echo "  Installation Complete!"
echo "================================"
echo ""
echo "Get started with /fly:brainstorm or /fly:research to explore your feature idea"
echo ""
