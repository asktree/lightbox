# BLE scan for the Yoolax blind's pairing advertisement.
# Run this from a GUI terminal on Hearth (Terminal.app / iTerm), NOT over ssh:
#   /private/tmp/claude-501/-Users-ix-Coding-lightbox/e54f361e-9955-4134-b51a-1c0921e99328/scratchpad/blevenv/bin/python scan-ble.py
# Allow the Bluetooth permission prompt if one appears.
import asyncio
from bleak import BleakScanner

async def main():
    found = {}
    def cb(dev, adv):
        found[dev.address] = (dev.name or adv.local_name or '(no name)', adv.rssi,
                              sorted(adv.service_uuids or []),
                              sorted((adv.service_data or {}).keys()),
                              sorted((adv.manufacturer_data or {}).keys()))
    try:
        scanner = BleakScanner(cb)
        await asyncio.wait_for(scanner.start(), 10)
    except Exception as e:
        print('BLE start failed:', type(e).__name__, e)
        print('-> grant Bluetooth to this terminal: System Settings > Privacy & Security > Bluetooth')
        return
    print('scanning 15s — make sure the blind is flashing blue...', flush=True)
    await asyncio.sleep(15)
    await scanner.stop()
    for addr, (name, rssi, uuids, sdata, mfg) in sorted(found.items(), key=lambda x: -x[1][1]):
        blob = ' '.join(uuids + sdata).lower()
        tags = ''
        if 'fff6' in blob: tags = '  <<< MATTER PAIRING MODE'
        elif any(k in blob for k in ('a201', '1910', 'fd50', '2b11')) or (name or '').lower().startswith('ty'):
            tags = '  <-- tuya-ish'
        print(f'{name[:26]:26} | rssi {rssi:5} | svc:{uuids} sd:{sdata} mfg:{mfg}{tags}')
    print(f'--- {len(found)} BLE devices seen')

asyncio.run(main())
