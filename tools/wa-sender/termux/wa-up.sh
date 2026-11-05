#!/data/data/com.termux/files/usr/bin/sh
# Brings the phone side back up: SSH (for the PC) and the WhatsApp sender. Safe to run any number of times:
# it starts only what is not already running. Called from three places so nobody has to type anything:
#   - ~/.termux/boot/00-wa-up.sh  (Termux:Boot, when the phone starts)
#   - ~/.bashrc                    (every time the Termux app is opened)
#   - termux-job-scheduler, every 15 min (needs the Termux:API app; Android starts Termux again to run it after EMUI kills it)
# Install (once): see docs/whatsapp/README.md section 4B step 6.
DIR="$HOME/teaching.ezznasr.dev/tools/wa-sender"
termux-wake-lock 2>/dev/null           # keep the CPU awake while the screen is off
pgrep -x sshd >/dev/null || sshd
PID=$(cat "$DIR/data/loop.pid" 2>/dev/null)
if [ -z "$PID" ] || ! grep -q start-wa-sender "/proc/$PID/cmdline" 2>/dev/null; then
  echo "$(date '+%F %T')  wa-up: sender was not running, starting it (${1:-manual})" >> "$DIR/data/sender.log"
  (nohup sh "$HOME/.termux/start-wa-sender.sh" >/dev/null 2>&1 &)
fi
