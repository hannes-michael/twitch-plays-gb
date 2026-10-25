# Vendored test ROMs

These ROMs are open-source homebrew fixtures used only by automated tests. They
are not commercial games. Do not add copyrighted ROMs to this directory.

| File            | Console | Description                                                            | Source                                                                 | License                  |
| --------------- | ------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| `test_gb.gb`    | GB      | Mooneye boot-register acceptance test                                  | https://github.com/Gekkio/mooneye-test-suite                           | MIT (LICENSE-MIT.txt)    |
| `test_gbc.gbc`  | GBC     | cgb-acid2 PPU conformance test                                         | https://github.com/mattcurrie/cgb-acid2                                | MIT (CGB-ACID2-LICENSE.txt) |
| `test_gba.gba`  | GBA     | mGBA key-interrupt and display test                                     | https://github.com/mgba-emu/mgba                                       | MPL-2.0 (LICENSE-MPL-2.0.txt) |

`test_gb.gb`, `test_gba.gba`, `LICENSE-MIT.txt`, and `LICENSE-MPL-2.0.txt` are
vendored from the [node-mgba](https://github.com/ARISE-Foundation/node-mgba)
test fixtures, whose NOTICE describes the upstream sources above.

The GBA ROM is distributed under MPL-2.0. Its source is available at the mGBA
repository linked above, in accordance with MPL-2.0 Section 3.2.

The cgb-acid2 ROM is distributed under the MIT license. Its source is available
at the cgb-acid2 repository linked above.
