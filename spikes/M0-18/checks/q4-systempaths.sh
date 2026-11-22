#!/bin/sh
# Q4: what systempaths=unconfined opens. Access checks only (test -r / test -w); nothing is written.
echo "as $(id -u): $(grep CapEff /proc/self/status | tr -s '\t' ' ')"
for p in /proc/kcore /proc/keys /proc/timer_list /proc/sched_debug /proc/interrupts /proc/sysrq-trigger /proc/sys/kernel/core_pattern /proc/sys/kernel/modprobe /proc/sys/vm/drop_caches /sys/firmware /sys/devices/virtual/powercap /sys/kernel/security; do
  r=no; w=no; [ -r $p ] && r=yes; [ -w $p ] && w=yes
  echo "  $p read=$r write=$w mount=$(awk -v p=$p '$5==p{print $9" "$6}' /proc/self/mountinfo | head -1)"
done
