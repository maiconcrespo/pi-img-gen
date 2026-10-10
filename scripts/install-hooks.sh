#!/bin/sh
# Install the composed pre-commit hook (scripts/hooks/pre-commit) into this
# repo's .git/hooks. Idempotent: safe to run more than once.
# A pre-existing foreign hook is backed up to pre-commit.bak-<timestamp>.
set -u

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
    echo "ERROR: not inside a git repository." >&2
    exit 1
fi

ROOT=$(cd "$(git rev-parse --show-toplevel)" && pwd)
SRC="$ROOT/scripts/hooks/pre-commit"

if [ ! -f "$SRC" ]; then
    echo "ERROR: source hook not found: $SRC" >&2
    exit 1
fi

# Honors core.hooksPath / worktree git dirs; resolves to an absolute path.
HOOKS_DIR=$(cd "$(git rev-parse --git-path hooks)" 2>/dev/null && pwd)
if [ -z "${HOOKS_DIR:-}" ] || [ ! -d "$HOOKS_DIR" ]; then
    HOOKS_DIR="$ROOT/.git/hooks"
    mkdir -p "$HOOKS_DIR"
fi

TARGET="$HOOKS_DIR/pre-commit"

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    if [ -f "$TARGET" ] && cmp -s "$TARGET" "$SRC"; then
        chmod +x "$TARGET"
        echo "pre-commit hook already installed (identical to scripts/hooks/pre-commit); nothing to do."
        exit 0
    fi
    BAK="$TARGET.bak-$(date +%Y%m%d%H%M%S)"
    mv "$TARGET" "$BAK"
    echo "Existing pre-commit hook is not ours; backed up to: $BAK"
fi

if ln -s "$SRC" "$TARGET" 2>/dev/null; then
    echo "Linked $TARGET -> $SRC"
else
    cp "$SRC" "$TARGET"
    echo "Copied $SRC -> $TARGET (symlink unavailable)"
fi

chmod +x "$TARGET"
echo "pre-commit hook installed and executable."
