#!/bin/bash
# Helper script to format a PEM private key for .env file
# Usage: ./scripts/format-key.sh path/to/private_key.pem

if [ -z "$1" ]; then
    echo "Usage: ./scripts/format-key.sh path/to/private_key.pem"
    echo ""
    echo "This will output a single-line version of your key"
    echo "that you can paste into your .env file"
    exit 1
fi

if [ ! -f "$1" ]; then
    echo "Error: File '$1' not found"
    exit 1
fi

# Convert multi-line PEM to single line with \n
KEY=$(cat "$1" | tr '\n' '~' | sed 's/~$//' | sed 's/~/\\n/g')

echo ""
echo "Copy this entire line into your .env file:"
echo ""
echo "KALSHI_PRIVATE_KEY=$KEY"
echo ""
