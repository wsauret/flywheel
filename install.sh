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
echo "Context7 provides up-to-date framework documentation for the planning workflow."
echo "Get a free API key at: https://context7.com/dashboard"
echo ""
read -p "Enter your Context7 API key (or press Enter to skip): " API_KEY

if [ -n "$API_KEY" ]; then
    echo ""
    echo "Configuring Context7 MCP server..."

    # Remove existing context7 config if present
    claude mcp remove context7 2>/dev/null || true

    # Add with the API key header
    claude mcp add --header "CONTEXT7_API_KEY: $API_KEY" --transport http context7 https://mcp.context7.com/mcp

    echo "  ✓ Context7 configured with your API key"
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
