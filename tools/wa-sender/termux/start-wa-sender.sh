#!/data/data/com.termux/files/usr/bin/sh
# Starts the WhatsApp sender when the phone boots (Termux:Boot), and restarts it if it ever stops.
# Install: mkdir -p ~/.termux/boot && cp ~/teaching.ezznasr.dev/tools/wa-sender/termux/start-wa-sender.sh ~/.termux/boot/ && chmod +x ~/.termux/boot/start-wa-sender.sh
termux-wake-lock                       # keep the CPU awake while the screen is off
cd "$HOME/teaching.ezznasr.dev/tools/wa-sender" || exit 1
mkdir -p data
while true; do
  node sender.js >> data/sender.log 2>&1
  echo "$(date '+%F %T')  sender stopped (exit $?), restarting in 30 s" >> data/sender.log
  sleep 30
done
