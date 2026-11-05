#!/data/data/com.termux/files/usr/bin/sh
# Runs the WhatsApp sender and restarts it if it ever stops. Started by wa-up.sh (boot, opening Termux, the 15-min watchdog).
# Install: see wa-up.sh. Writes its own PID to data/loop.pid so wa-up.sh can tell whether it is already running.
termux-wake-lock 2>/dev/null           # keep the CPU awake while the screen is off
cd "$HOME/teaching.ezznasr.dev/tools/wa-sender" || exit 1
mkdir -p data
echo $$ > data/loop.pid
while true; do
  node sender.js >> data/sender.log 2>&1
  echo "$(date '+%F %T')  sender stopped (exit $?), restarting in 30 s" >> data/sender.log
  sleep 30
done
