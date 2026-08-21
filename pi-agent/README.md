# ATP Print Agent

Runs on a Raspberry Pi at the shop counter. Listens for **paid** print jobs,
downloads the files, and prints them via CUPS.

The copy count comes from the paid job and goes straight to `lp -n`. There is
no OS print dialog anywhere in the flow, so a customer cannot print more copies
than they paid for.

---

## 1. Install the OS

On your PC, install **Raspberry Pi Imager** from raspberrypi.com/software.

- Choose **Raspberry Pi OS (64-bit)**
- Click the **gear icon** before writing and set:
  - hostname: `atp`
  - enable **SSH** (password authentication)
  - username + password (remember these)
  - your **Wi-Fi** name and password
  - your Wi-Fi country

Write to the SD card, put it in the Pi, power on, wait ~90 seconds.

## 2. Connect from your PC

```bash
ssh <username>@atp.local
```

If `atp.local` doesn't resolve, find the Pi's IP in your router's device list
and use `ssh <username>@<ip>` instead.

## 3. Install CUPS, drivers and Node

```bash
sudo apt update
sudo apt install -y cups printer-driver-brlaser printer-driver-cups-pdf nodejs npm git
sudo usermod -aG lpadmin,lp $USER
sudo reboot
```

Brother's own Linux drivers are x86-only — on a Pi (ARM) use `brlaser`, which
is what the command above installs.

## 4. Add the printer

Plug the printer in via USB and turn it on, then:

```bash
lpinfo -v          # shows detected devices
sudo lpadmin -p ATP_Printer -E -v usb://... -m drv:///brlaser.drv/br2080.ppd
lpstat -p          # confirm it exists
```

Easier alternative — use the CUPS web interface from your PC's browser at
`https://atp.local:631` → **Administration → Add Printer**.

**Before the real printer arrives** you can test with the virtual PDF printer
that was installed above: use `PDF` as the printer name. Jobs "print" to
`~/PDF/` so you can open them and check the pages and copy count are right.

## 5. Pair the agent

```bash
git clone https://github.com/preethampaulsocrates/ZipBeam.git
cd ZipBeam/pi-agent
cp config.example.json config.json
nano config.json
```

In ZipBeam (signed in as the shop) open the account panel → **Print agent** →
**+ Pair a printer**. Copy the token it shows — it is displayed **once only** —
and paste it into `config.json` along with your printer name:

```json
{
  "serverUrl": "https://zipbeam.in",
  "deviceToken": "…64 hex characters…",
  "printer": "ATP_Printer",
  "duplex": false,
  "extraLpOptions": []
}
```

Run it:

```bash
node agent.js
```

You should see `📡 Connected — waiting for paid jobs`.

## 6. Start automatically on boot

```bash
sudo cp atp-agent.service /etc/systemd/system/atp-agent@.service
sudo systemctl enable --now atp-agent@$USER
systemctl status atp-agent@$USER      # check it is running
journalctl -u atp-agent@$USER -f      # watch live logs
```

---

## Config reference

| Key | Meaning |
|---|---|
| `serverUrl` | Your ZipBeam server, no trailing slash |
| `deviceToken` | 64-hex token from the pairing screen |
| `printer` | CUPS printer name (`lpstat -p` to list) |
| `duplex` | `true` to print double-sided |
| `extraLpOptions` | Extra `lp -o` options, e.g. `["media=A4"]` |

## Troubleshooting

**`Printer "X" not found by CUPS`** — run `lpstat -p` and use the exact name shown.

**`Server rejected the device token`** — the device was unpaired, or the token
was mistyped. Pair again and update `config.json`.

**Nothing prints** — check `lpstat -t` for a paused queue, and confirm the job
reached the agent with `journalctl -u atp-agent@$USER -f`.

**Jobs paid while the Pi was off** — these are picked up automatically the next
time the agent connects; nothing is lost.
