#!/usr/bin/env bash
# Setup Mnemos for Hermes Agent
# Usage: bash setup_mnemos.sh [vault_path]
#
# Installs mnemos globally, initializes a vault, and runs the Hermes bridge.
# Restart Hermes after running.

set -euo pipefail

VAULT="${1:-$HOME/brain}"

echo "=== Mnemos Setup for Hermes Agent ==="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required. Install from https://nodejs.org"
  exit 1
fi

# Install mnemos
if ! command -v mnemos &>/dev/null; then
  echo "Installing mnemos..."
  npm install -g mnemos
else
  echo "mnemos already installed: $(mnemos --version)"
fi

# Initialize vault
if [ -d "$VAULT/.mnemos" ]; then
  echo "Vault already exists at $VAULT"
else
  echo "Initializing vault at $VAULT..."
  mnemos init "$VAULT"
fi

# Run bridge
echo "Installing Hermes bridge..."
mnemos bridge hermes --vault "$VAULT"

echo ""
echo "Done. Restart Hermes to activate Mnemos memory."
echo "Vault: $VAULT"
