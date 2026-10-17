// Tests for public/qr.js (node N4a). Run: node --test test/qr.test.js
//
// How the reference data below was obtained and cross-checked
// ------------------------------------------------------------
// * Reed–Solomon: the ISO/IEC 18004 Annex I worked example ("01234567", 1-M) lists
//   its 16 data codewords and 10 error-correction codewords; we feed those data
//   codewords to rsEncode. A second vector is the widely published "HELLO WORLD"
//   1-M example (thonky.com QR tutorial). Both were also reproduced by two
//   independent encoders: Project Nayuki's qrcodegen (as vendored in
//   @rc-component/qrcode 2.0.0) and node-qrcode 1.5.4 (soldair).
// * Format and version information words: ISO 18004 Annex C (Table C.1) and
//   Annex D (Table D.1); every value was re-checked against node-qrcode's
//   format-info.js / version.js.
// * Byte-mode capacities: ISO 18004 Table 7 (versions 1–10, levels L/M/Q/H).
// * Full module matrices (REFERENCE_MATRICES): generated once, offline, with
//   Nayuki's qrcodegen (encodeSegments with a single byte segment, boostEcl
//   off, automatic mask). Each matrix was then rebuilt with node-qrcode forced
//   to the same version and mask, and — for ASCII inputs — with Kazuhiko
//   Arase's "QRCode for JavaScript" (as vendored in qrcode-terminal), also
//   forced to the same version and mask. All three independent encoders produced
//   bit-identical matrices. Nayuki's automatic mask choice is what our encoder
//   must reproduce (node-qrcode scores penalty rule 3 differently, so its own
//   mask choice sometimes differs; that is expected and not a defect). During
//   development the same three-way comparison was also run over all 8 forced
//   masks × 4 levels for these inputs, plus 1,500 random byte strings spanning
//   versions 1–10, with zero mismatches. None of those libraries is a
//   dependency; they were only used to produce the constants below.
//   Rows are hex, most significant bit = leftmost module, padded to 4 bits.
// * VERSION_LEVEL_DIGESTS (iteration 2): for every version 1–10 × level L/M/Q/H,
//   the input filler(capacity) — the deterministic ASCII string below, exactly
//   as long as that version's byte capacity at that level — was encoded with
//   Nayuki's qrcodegen (automatic mask, boostEcl off; every one landed on the
//   intended version). The matrix was rebuilt with node-qrcode 1.5.4 (its own
//   minimum version, mask forced to Nayuki's) and with Arase's encoder (same
//   version and mask): all 40 bit-identical. We pin Nayuki's mask and the
//   SHA-256 of its hex rows joined with "\n". This pins the block tables,
//   alignment positions and mask choice of every supported version.
// * PENALTY_SCORES: Nayuki's getPenaltyScore() on its own symbol with the mask
//   forced to 0–7 (same matrices as ours, see above). "http://recipes.local:1595"
//   at M is a real tie — masks 4 and 6 both score 1192 — and Nayuki picks 4.
// * Decoding: headless Chrome's BarcodeDetector (shape-detection API backed by
//   the OS barcode reader) must read our SVG output back to the exact text.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encode, toSvg, rsEncode, formatBits, versionBits, byteCapacity, penalty } from '../public/qr.js';

const QR_SOURCE = fileURLToPath(new URL('../public/qr.js', import.meta.url));

// A 200-byte URL (pure ASCII, so 200 UTF-8 bytes) — needs version 10 at level M.
const URL_200 = ('http://recipes.local:23456/recipes/search?q=' + 'tomato-basil-soup-'.repeat(12)).slice(0, 200);

// Deterministic printable-ASCII filler of n bytes (cycles through all 94 printable characters).
const filler = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(33 + ((i * 37 + 11) % 94))).join('');

// Reference matrices — see the header comment for provenance.
const REFERENCE_MATRICES = [
  {
    text: 'Hello, world!',
    ecc: 'M',
    version: 1,
    mask: 2,
    rows: [
      'fe0bf8',
      '825208',
      'babae8',
      'ba82e8',
      'bacae8',
      '82f208',
      'feabf8',
      '00a000',
      'be73e0',
      '198ce8',
      '12ee70',
      '653d60',
      'de8b08',
      '0087c0',
      'fe6f30',
      '82ad70',
      'bade98',
      'baa1c0',
      'bafb20',
      '822ce0',
      'fed290',
    ],
  },
  {
    text: 'http://recipes.local',
    ecc: 'M',
    version: 2,
    mask: 2,
    rows: [
      'fe60bf8',
      '8275a08',
      'baaaae8',
      'baa62e8',
      'bae0ae8',
      '8299208',
      'feaabf8',
      '00b3800',
      'be563e0',
      '681c910',
      '973b358',
      'a990d08',
      '07006b8',
      'a84c150',
      '8e478d8',
      '940c648',
      'ababfa0',
      '00a08e0',
      'fe18af8',
      '82928c8',
      'bad1ff8',
      'ba8e7b8',
      'bae6528',
      '820dbc8',
      'feca3f8',
    ],
  },
  {
    text: 'http://recipes.local:23456',
    ecc: 'M',
    version: 2,
    mask: 2,
    rows: [
      'fe20bf8',
      '8235a08',
      'ba82ae8',
      'baee2e8',
      'bac0ae8',
      '82f1208',
      'feaabf8',
      '00cb800',
      'be563e0',
      '941c910',
      '2ebb358',
      '2180d08',
      '220c6b8',
      'ecae150',
      '8bcd8d8',
      '9910648',
      'afa5fa0',
      '00ba8e0',
      'fe64af8',
      '82c08c0',
      'baa5fe0',
      'bada7b8',
      'baec528',
      '8243bc8',
      'fe843f8',
    ],
  },
  {
    text: 'naïve café ☕',
    ecc: 'M',
    version: 2,
    mask: 6,
    rows: [
      'fee73f8',
      '82c7208',
      'bade2e8',
      'ba43ae8',
      'baa52e8',
      '8256208',
      'feaabf8',
      '005a800',
      '9f9f4b8',
      'f45a9a8',
      '2a223a0',
      '9902c08',
      '9736158',
      'f8c82e0',
      'df82a98',
      '91cfce0',
      'a7f9fa0',
      '00b08f0',
      'feaeac8',
      '82d58c8',
      'baf4fc8',
      'baec878',
      'ba55598',
      '827c438',
      'fefdbc8',
    ],
  },
  {
    text: URL_200.slice(0, 120),
    ecc: 'M',
    version: 7,
    mask: 2,
    rows: [
      'fe605753cbf8',
      '825cb8a01208',
      'badad89ed2e8',
      'badf6ff31ae8',
      'badc1fcebae8',
      '82d1c8a84208',
      'feaaaaaaabf8',
      '00ad08fb9000',
      'be425f8503e0',
      'f135a30719b8',
      '2a7ce3f1e3b0',
      'd90ae5ebc9e0',
      'a7a6f7472708',
      'a85b00471d78',
      'f24dfdade330',
      '807070edccf0',
      'e62477e10018',
      'a52a40471c38',
      '3a5109a92350',
      '7048757ccef0',
      '6fb2ffe50f98',
      'a8a318d718f8',
      '6acf2ae1bab0',
      '38ca68bcc8f0',
      'dfd8bfa43fc8',
      '3c427a8e1468',
      'b28d0b75fcf0',
      'b93b5c9bf6e0',
      '3bbb553446c8',
      '1cf47ed74748',
      '57a4ea283140',
      '75aca8fcd360',
      '6223f0d32498',
      'c92a5ed60c48',
      '0a7183306440',
      '78cbd3cc9260',
      '9bce0fc64fc0',
      '00c1f8c798e8',
      'fe16faf1fab0',
      '82d1589ef8f8',
      'bac56fa71fc0',
      'baf8b18f07b8',
      'baa3beecbe50',
      '8278e919a820',
      'fedfc7c73a90',
    ],
  },
  {
    text: URL_200,
    ecc: 'M',
    version: 10,
    mask: 6,
    rows: [
      'fe9bbcaaaaab3f8',
      '82c3c11575c5208',
      'baf42684035f2e8',
      'ba703a3acbcd2e8',
      'ba84aebf82b12e8',
      '823022e206c2208',
      'feaaaaaaaaaabf8',
      '00395d2312a4800',
      '9f91067e2ce24b8',
      '50b1b7d3fff7ad0',
      '5a8b1a2d2896908',
      'c034399bf12a670',
      '16cfb9deccad0d8',
      'e15369168375fd0',
      '06c7fe78ce557e0',
      '6d684f424444868',
      'ba8964258c5b000',
      '394f0e9b7da6988',
      '1f80909549c8c08',
      '6407ddbd06b17f8',
      '23b1b36808d2180',
      '7cc8c9bd6f6fe80',
      '36b022b6e4d3568',
      '58c011965319a20',
      'cad0274e2caa280',
      '48efff9f4f6da50',
      '9f8cb73eda05fe0',
      'f89e016234228e8',
      '8adfb12abd1ba98',
      '6899b8a3fd3f898',
      '9fdf2d3e4c5dfa8',
      '644f5ab966b1560',
      'c69315f519a2208',
      'e53e5e8efebf7a8',
      '22c2e6caa552610',
      'e90d35a8a41e7a0',
      '77102878caeb058',
      'fcbf55dc5bec340',
      '96ced95753898e0',
      '30d8911046478f8',
      '6a3f051faa1d5d0',
      '0d7186bb6cb67a8',
      'a392b1029494668',
      '6c5cf6a596b75e8',
      '1bb016733fe6058',
      '245d4b9efaeb3f0',
      'a6069bc73c8ef78',
      'f8a62af286583b0',
      '035e0c3ebaabfd8',
      '0084d9e3d26c8a0',
      'fecec3aa4e89a90',
      '82f586a323428e8',
      'ba9d75fffc2bfc0',
      'bae19c2365bf700',
      'ba224d6ac484e98',
      '825a711e06d0f78',
      'feb6781c2cd7fc0',
    ],
  },
  {
    text: 'http://recipes.local',
    ecc: 'H',
    version: 3,
    mask: 3,
    rows: [
      'fe61ebf8',
      '822f5a08',
      'ba2eaae8',
      'ba7552e8',
      'bac6f2e8',
      '822f1a08',
      'feaaabf8',
      '00e2f800',
      '33f89e80',
      '68304788',
      'dbf5c6d0',
      '058f1448',
      '9ff9e438',
      '2c0e5378',
      '72819ad8',
      'cdaca840',
      'c3a68dd0',
      '49eeb920',
      'ba97b320',
      '1cb296e0',
      '6e46cff8',
      '00d5e8d8',
      'feb3dab0',
      '82622888',
      'ba540ff0',
      'baca24d0',
      'bafef448',
      '820b42d0',
      'fe5fc910',
    ],
  },
];

function toHexRows(modules) {
  return modules.map((row) => {
    let s = '';
    for (let i = 0; i < row.length; i += 4) {
      let v = 0;
      for (let j = 0; j < 4; j++) v = (v << 1) | (row[i + j] ? 1 : 0);
      s += v.toString(16);
    }
    return s;
  });
}

describe('building blocks', () => {
  test('Reed–Solomon matches the ISO 18004 Annex I worked example (1-M, "01234567")', () => {
    const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
    assert.deepEqual(rsEncode(data, 10), [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
  });

  test('Reed–Solomon matches the published "HELLO WORLD" 1-M example', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    assert.deepEqual(rsEncode(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  test('format information words (ISO 18004 Table C.1)', () => {
    const table = {
      L: ['111011111000100', '111001011110011', '111110110101010', '111100010011101', '110011000101111', '110001100011000', '110110001000001', '110100101110110'],
      M: ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'],
      Q: ['011010101011111', '011000001101000', '011111100110001', '011101000000110', '010010010110100', '010000110000011', '010111011011010', '010101111101101'],
      H: ['001011010001001', '001001110111110', '001110011100111', '001100111010000', '000011101100010', '000001001010101', '000110100001100', '000100000111011'],
    };
    for (const [ecc, words] of Object.entries(table)) {
      words.forEach((w, mask) => assert.equal(formatBits(ecc, mask), parseInt(w, 2), `${ecc} mask ${mask}`));
    }
  });

  test('version information words (ISO 18004 Table D.1)', () => {
    assert.equal(versionBits(7), 0x07c94);
    assert.equal(versionBits(8), 0x085bc);
    assert.equal(versionBits(9), 0x09a99);
    assert.equal(versionBits(10), 0x0a4d3);
  });

  test('byte-mode capacities match ISO 18004 Table 7 for versions 1–10', () => {
    const table = {
      L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
      M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
      Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
      H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119],
    };
    for (const [ecc, caps] of Object.entries(table)) {
      caps.forEach((cap, i) => assert.equal(byteCapacity(i + 1, ecc), cap, `${ecc} v${i + 1}`));
    }
  });
});

describe('fixed reference matrices', () => {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    test(`versions 1–10 at level ${ecc} (input at full capacity) match the reference digests`, () => {
      VERSION_LEVEL_DIGESTS[ecc].forEach(([mask, digest], i) => {
        const version = i + 1;
        const qr = encode(filler(byteCapacity(version, ecc)), { ecc });
        assert.equal(qr.version, version, `${ecc} v${version}`);
        assert.equal(qr.mask, mask, `${ecc} v${version} mask`);
        assert.equal(createHash('sha256').update(toHexRows(qr.modules).join('\n')).digest('hex'), digest, `${ecc} v${version}`);
      });
    });
  }


  for (const ref of REFERENCE_MATRICES) {
    const label = `${JSON.stringify(ref.text.length > 32 ? ref.text.slice(0, 32) + '…' : ref.text)} ` +
      `(${new TextEncoder().encode(ref.text).length} bytes, ${ref.ecc}) → version ${ref.version}, mask ${ref.mask}`;
    test(label, () => {
      const qr = encode(ref.text, { ecc: ref.ecc });
      assert.equal(qr.version, ref.version);
      assert.equal(qr.mask, ref.mask);
      assert.equal(qr.size, ref.version * 4 + 17);
      assert.equal(qr.modules.length, qr.size);
      for (const row of qr.modules) {
        assert.equal(row.length, qr.size);
        for (const c of row) assert.equal(typeof c, 'boolean');
      }
      const got = toHexRows(qr.modules);
      const firstBad = got.findIndex((row, y) => row !== ref.rows[y]);
      assert.equal(firstBad, -1, `first differing row: ${firstBad}`);
      assert.deepEqual(got, ref.rows);
    });
  }

  // Same three-way provenance as REFERENCE_MATRICES, but with the mask forced to
  // each of 0–7 (so every mask formula is pinned); stored as SHA-256 of the hex
  // rows joined with "\n" to keep the file short.
  test('every forced mask matches the reference ("http://recipes.local:23456", M, version 2)', () => {
    const digests = [
      '0959b184cf2fa0150f86c3496ca3393e1295d7e81177c48a8c3de24a614410c5',
      '2ca09c11024fe4fb688a1379319938afbcdf8c5c2e39b9fb41f14a1bdede08d7',
      '76e1a754a21868402f7745b107497cb4c3e8c8a9e0f84a02917a00c821469435',
      '383dc29ebd16ede3433a0b0b33f19895324750e921cc90395e28edb41a9ea392',
      'ca19f6b40829c0df6b601df2977c26d0ddf8033071073813551578a8f4cfd7e2',
      'e3608725fc7470a7fabfa3a9b33feb3704119d8e3fa515f6018530c0cacad8da',
      '942fa580ae59a5c0fe1770cebd89534abef4ffef721bd42680f4745115c2240e',
      '095781e9e873c2125bcc72e59e3f045bc1c27c0662118df207b9d5f732d93e5a',
    ];
    digests.forEach((digest, mask) => {
      const qr = encode('http://recipes.local:23456', { mask });
      assert.equal(qr.mask, mask);
      assert.equal(createHash('sha256').update(toHexRows(qr.modules).join('\n')).digest('hex'), digest, `mask ${mask}`);
    });
  });

  test('ecc defaults to M', () => {
    assert.deepEqual(encode('http://recipes.local'), encode('http://recipes.local', { ecc: 'M' }));
  });
});

// [mask, sha256(hex rows joined by "\n")] for versions 1–10 — see the header for provenance.
const VERSION_LEVEL_DIGESTS = {
  L: [
    [7, '6f6bca7bd3cae4c3e45129314e199c33e9e135da250788c018238f3431d20b50'], // v1
    [6, '196f4f35e982eb9539fde07e9c488bdd7e54039accd2ccb007249cdc69519753'], // v2
    [2, 'c2b5da6a460940ea685da29696ec46548984d850038da4859041f967bb76a4f2'], // v3
    [6, '33c1d3a27dd9f98c42571ff8b2e85c4e094d58e95548800241807789c5a83c7b'], // v4
    [7, 'c3ad2701372213fdc735f49291046415084809dca6747978304efbf353d76f16'], // v5
    [2, '4bf29475bd0c33d5930b1907917a77cc110f333c9ce472b18662d795c9225cd3'], // v6
    [3, '12647582773cd1255f3394c32943e71ff6c55d2f788fe14e29ea9fd86f559caa'], // v7
    [2, 'd4e23a425861b70f3337e27de81d74850947c870db5c009a9a4267c807b69ffa'], // v8
    [2, '3f0f2733428322424beb454ad458081104a704d26cc60c2f60e6ff6efc5a9488'], // v9
    [6, 'f96ab7c9c9b4b48268549937319d72c66312de1e5fb95e3ed3812f8690da7089'], // v10
  ],
  M: [
    [3, '996d4e796cb66d04e2698a7db677aad98e071836cc7aa4ae895f6a818b07972c'], // v1
    [1, 'fc57acf859fbfd43a4bc96b236f8b9fd135741da8eb34a0e9a8a2102e752fc63'], // v2
    [2, '817a90ac7054663299387eabec87faf336ca23063f4ca5281c64c4494e0b0ab1'], // v3
    [3, '46a90a1d95bcef88aebb9d7e6df2ed84db90594e59e03c366f1769472fea65b1'], // v4
    [3, '6412d72b4c1d82036df4d17465d7edbab4cfb6b02bc510b45252828faf2105cd'], // v5
    [2, '6dbf3bf91c2323f72e2492cdd3b02745ecc3cf5984d0c46be17d25540aa53d7d'], // v6
    [3, '8d958705419a6b6a36ba56ef67f037bb17028543f03c1e7b7ffebd0e58cf937a'], // v7
    [2, '7cbc24d6e6c724da6c3bbe35a62f354e8831c98eee973889fedf39dc908613b7'], // v8
    [7, 'fb14378e33e128cf88d31026c21816a99d62eb13fa781396ae8a1d16492ef6b0'], // v9
    [6, '77ae4a510e5f82788919ef5111e600c9709243f78fe709effa225282e14e0a8a'], // v10
  ],
  Q: [
    [0, 'f4dfc74b86c315156207efe62e720773d795168bf8b6d13adb3cf9474d4fd798'], // v1
    [7, '7aee813ed4f137d117689a158ebd7d870154dc8743d580421db676aaaf6f0036'], // v2
    [6, '52ae7878de0e770211e1c31d943ed1e882919f15bf9e790973571ee995e54933'], // v3
    [7, '9370bbe5d045c0eb772e7093b8cb27e379ccc0663ec0d314fb70cd9225f3c824'], // v4
    [0, '0528770138f744aa36cee836abee7d3caff7f38fea682ad6ad86470a0d2bc618'], // v5
    [6, '5164fe8235c0fb397e77502fa6ac44054c529a2cff388d2aad46e73486a76db1'], // v6
    [0, '5d4b8f868715770088be5fd6af6be0da47deb29a1c14270b9d4c340fd41f31c7'], // v7
    [4, 'e825836b0796a5a924ca601998692896de36f38ed724a3d95000a77f36f6dbe3'], // v8
    [2, '6e591786de7c6f195e9c0b0d491fb163e1da040b6a367f8cc0d0c646b44407b8'], // v9
    [0, 'fd5fd85d19cf764b932d7611529d909657a7b78da5ad41faeb218aa6449418e5'], // v10
  ],
  H: [
    [1, 'aaac1b94cf630183ca4bd17db90f27de766e06149ccf09f712990285a4a69132'], // v1
    [1, '2cae0f784efe66791e5d325237fbd275d5ea72f973a4729c2f6817be32d19d27'], // v2
    [1, '93d5ea122c016ff857d9b97543bcb1fff273bc9f26957065d6bb9e5053e3eabf'], // v3
    [1, 'fb119b7e1762205209f8a051c107c87d97c20a8bd26dee5cc7159dabe1fb6500'], // v4
    [6, '6dca4f4f4d3bbd8e2b828419445f1c9010dc2a3e8aed419c45b12c25b07ea7c6'], // v5
    [7, 'e4731a3938c3f5094991e28bae762f4b8d04f6164c8bb4c218277427e85ea799'], // v6
    [1, '5e65a608de784f3685a4613e326c457e676e1efa6083bf31ee7165d10ac8eff3'], // v7
    [3, '26e28c69dd868de299a069bbf395a82b2757a599d8341841b410e5a91c16a880'], // v8
    [2, '0b5f78e0a5c974fe1835e4528a32aaf55c8274faf68c902ed8e6b7b0d1464e7f'], // v9
    [2, 'be96f1fdb918997e26f1b6839a13d34aa76c6ded64c7c407b494f0abdeeb2655'], // v10
  ],
};

// Nayuki getPenaltyScore() for masks 0–7 at level M — see the header.
const PENALTY_SCORES = {
  'http://recipes.local:23456': [1203, 1418, 1176, 1306, 1246, 1298, 1304, 1355],
  'http://recipes.local:1595': [1473, 1244, 1204, 1485, 1192, 1246, 1192, 1511],
};

describe('mask selection', () => {
  for (const [text, scores] of Object.entries(PENALTY_SCORES)) {
    test(`penalty scores for masks 0–7 match Nayuki (${text}, M)`, () => {
      assert.deepEqual(Array.from({ length: 8 }, (_, mask) => penalty(encode(text, { mask }).modules)), scores);
    });
  }

  test('a real tie goes to the lowest mask ("http://recipes.local:1595", M: masks 4 and 6 both score 1192)', () => {
    const scores = PENALTY_SCORES['http://recipes.local:1595'];
    assert.equal(scores[4], 1192);
    assert.equal(scores[6], 1192);
    assert.equal(Math.min(...scores), 1192);
    assert.equal(encode('http://recipes.local:1595').mask, 4);
  });


  test('the chosen mask has the lowest penalty, ties going to the lowest index', () => {
    for (const text of ['http://recipes.local', 'http://recipes.local:23456', URL_200, 'naïve café ☕', 'x']) {
      for (const ecc of ['L', 'M', 'Q', 'H']) {
        let auto;
        try {
          auto = encode(text, { ecc });
        } catch {
          continue; // URL_200 does not fit at Q/H
        }
        const scores = Array.from({ length: 8 }, (_, mask) => penalty(encode(text, { ecc, mask }).modules));
        const best = scores.indexOf(Math.min(...scores));
        assert.equal(auto.mask, best, `${ecc} ${text.slice(0, 20)} scores ${scores}`);
        assert.deepEqual(auto.modules, encode(text, { ecc, mask: best }).modules);
      }
    }
  });

  test('encoding is deterministic', () => {
    assert.deepEqual(encode(URL_200), encode(URL_200));
  });
});

describe('capacity and argument errors', () => {
  test('the largest input that fits uses version 10', () => {
    assert.equal(encode('a'.repeat(213)).version, 10);
    assert.equal(encode('a'.repeat(271), { ecc: 'L' }).version, 10);
    assert.equal(encode('').version, 1);
  });

  test('input longer than version 10 capacity throws a clear RangeError', () => {
    assert.throws(() => encode('a'.repeat(214)), {
      name: 'RangeError',
      message: /too long.*214 bytes.*version 10.*error correction M.*at most 213 bytes/,
    });
    assert.throws(() => encode('a'.repeat(120), { ecc: 'H' }), { name: 'RangeError', message: /at most 119 bytes/ });
  });

  test('capacity is counted in UTF-8 bytes, not characters', () => {
    // 71 × "€" (3 bytes each) = 213 bytes fits; 72 = 216 bytes does not.
    assert.equal(encode('€'.repeat(71)).version, 10);
    assert.throws(() => encode('€'.repeat(72)), { name: 'RangeError', message: /216 bytes/ });
  });

  test('bad options throw', () => {
    assert.throws(() => encode('x', { ecc: 'X' }), { name: 'TypeError', message: /error correction level/ });
    assert.throws(() => encode('x', { mask: 8 }), { name: 'RangeError', message: /mask/ });
    assert.throws(() => encode(42), { name: 'TypeError' });
  });

  test('null options mean defaults', () => {
    assert.deepEqual(encode('http://recipes.local', null), encode('http://recipes.local'));
    assert.equal(toSvg(encode('x'), null), toSvg(encode('x')));
  });

  test('byteCapacity range-checks the version', () => {
    for (const v of [0, 11, 2.5, '3', undefined]) {
      assert.throws(() => byteCapacity(v), { name: 'RangeError', message: /version must be an integer 1–10/ });
    }
  });

  test('over-capacity binary input says "bytes" without "UTF-8"', () => {
    assert.throws(() => encode(new Uint8Array(214)), (err) => {
      assert.equal(err.name, 'RangeError');
      assert.match(err.message, /data is too long — 214 bytes, but .* at most 213 bytes/);
      assert.doesNotMatch(err.message, /UTF-8/);
      return true;
    });
    assert.equal(encode(new Uint8Array(213)).version, 10);
  });
});

describe('toSvg', () => {
  test('defaults: 7 px modules, 4-module quiet zone, black on white', () => {
    const qr = encode('http://recipes.local'); // version 2, 25 × 25
    const svg = toSvg(qr);
    const n = 25 + 8;
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
    assert.match(svg, new RegExp(`width="${n * 7}" height="${n * 7}" viewBox="0 0 ${n} ${n}"`));
    assert.match(svg, /<rect width="33" height="33" fill="#FFFFFF"\/>/);
    assert.match(svg, /<path d="[^"]+" fill="#000000"\/><\/svg>$/);
  });

  test('non-finite or non-numeric sizes throw a clear TypeError; bad values a RangeError', () => {
    const qr = encode('x');
    for (const bad of [Infinity, -Infinity, NaN, '7', null]) {
      assert.throws(() => toSvg(qr, { moduleSize: bad }), { name: 'TypeError', message: /moduleSize must be a finite number/ });
      assert.throws(() => toSvg(qr, { quietZone: bad }), { name: 'TypeError', message: /quietZone must be a finite number/ });
    }
    assert.throws(() => toSvg(qr, { moduleSize: 0 }), { name: 'RangeError', message: /moduleSize must be positive/ });
    assert.throws(() => toSvg(qr, { quietZone: 1.5 }), { name: 'RangeError', message: /quietZone must be a non-negative integer/ });
    assert.throws(() => toSvg(qr, { quietZone: -1 }), { name: 'RangeError' });
  });

  test('the path covers exactly the dark modules, offset by the quiet zone', () => {
    const qr = encode('http://recipes.local:23456');
    const quietZone = 2;
    const svg = toSvg(qr, { moduleSize: 3, quietZone });
    assert.match(svg, new RegExp(`width="${(qr.size + 4) * 3}"`));
    const d = /<path d="([^"]+)"/.exec(svg)[1];
    const painted = new Set();
    for (const [, x, y, run] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
      for (let i = 0; i < Number(run); i++) painted.add(`${Number(x) + i - quietZone},${Number(y) - quietZone}`);
    }
    const dark = new Set();
    qr.modules.forEach((row, y) => row.forEach((c, x) => c && dark.add(`${x},${y}`)));
    assert.deepEqual(painted, dark);
  });
});

test('qr.js has no imports and no Node-only globals (browser + Node 18 compatible)', () => {
  // Strip only real comments: "//" at line start or after whitespace (so "http://" in strings survives).
  const src = readFileSync(QR_SOURCE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.match(src, /http:\/\/www\.w3\.org\/2000\/svg/, 'string literals must survive comment stripping');
  assert.doesNotMatch(src, /\bimport\b|\brequire\s*\(|\bprocess\.|\bBuffer\b|\bglobalThis\b/);
});

// ---------------------------------------------------------------- headless Chrome decode

const CHROME = process.env.NIDUM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HAVE_CHROME = existsSync(CHROME);

const DECODER_PAGE = `<!doctype html><meta charset="utf-8"><title>qr decode</title><script>
window.decodeQr = async (svgs) => {
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const out = [];
  for (const svg of svgs) {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    out.push((await detector.detect(canvas)).map((b) => b.rawValue));
  }
  return out;
};
</script>`;

// A timer that never keeps the test process alive on its own.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

// Budgets are generous on purpose: the full `npm test` runs every suite in
// parallel and several of them launch Chrome at the same time (D22).
const LAUNCH_BUDGET_MS = 45_000; // spawn → decoder page loaded and ready, per attempt
const DECODE_BUDGET_MS = 60_000; // the decode itself
const LAUNCH_ATTEMPTS = 2; // the launch is retried once; the decode never is

function withDeadline(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms).unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Start one headless Chrome on the decoder page. Talks to it over
// --remote-debugging-pipe (fd 3 in, fd 4 out, NUL-delimited JSON), so no
// WebSocket or network port is needed. Every instance gets its own temp
// profile, which close() always removes.
function startChrome(attempt) {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'nidum-qr-test-'));
  const pagePath = join(dir, 'decode.html');
  writeFileSync(pagePath, DECODER_PAGE);
  const proc = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-pipe',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    `--user-data-dir=${join(dir, 'profile')}`,
    pathToFileURL(pagePath).href,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

  let stderrTail = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });
  let exitInfo = null;
  const exited = new Promise((resolve) => {
    proc.once('exit', (code, signal) => resolve((exitInfo = { code, signal })));
    proc.once('error', (err) => resolve((exitInfo = { code: null, signal: null, error: err.message })));
  });
  const pending = new Map();
  exited.then(() => {
    for (const waiter of pending.values()) waiter.reject(new Error('Chrome exited'));
    pending.clear();
  });
  const exitedEarly = exited.then((info) => {
    throw new Error(`Chrome exited early (code ${info.code}, signal ${info.signal}${info.error ? `, ${info.error}` : ''})`);
  });
  exitedEarly.catch(() => {});

  let nextId = 1;
  let buffer = '';
  proc.stdio[4].setEncoding('utf8'); // keeps multi-byte characters split across reads intact
  proc.stdio[4].on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        msg.error ? waiter.reject(new Error(`CDP ${msg.error.message}`)) : waiter.resolve(msg.result);
      }
    }
  });
  proc.stdio[3].on('error', () => {});
  proc.stdio[4].on('error', () => {});
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (exitInfo) return reject(new Error('Chrome exited'));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });

  let sessionId = null;
  let phase = 'starting';
  let readyAt = null;

  // Wait until the decoder page itself (not the initial about:blank) has
  // loaded and defined window.decodeQr. Evaluating any earlier can land in a
  // context that the navigation then destroys, which is what loaded machines hit.
  async function ready() {
    while (!exitInfo) {
      try {
        if (!sessionId) {
          phase = 'waiting for the page target';
          const { targetInfos } = await send('Target.getTargets');
          const page = targetInfos.find((t) => t.type === 'page');
          if (page) ({ sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true }));
        }
        if (sessionId) {
          phase = 'waiting for the decoder page to load';
          const { result } = await send('Runtime.evaluate', {
            expression: "location.protocol === 'file:' && document.readyState === 'complete' && typeof window.decodeQr === 'function'",
            returnByValue: true,
          }, sessionId);
          if (result.value === true) {
            phase = 'ready';
            readyAt = Date.now();
            return;
          }
        }
      } catch {
        // Not ready yet (browser still starting, context swapped mid-navigation): poll again.
      }
      await delay(100);
    }
    throw new Error('Chrome exited');
  }

  async function evaluate(expression) {
    phase = 'decoding';
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(`page error: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    phase = 'done';
    return result.value;
  }

  function diagnostics() {
    const lines = stderrTail.trim().split('\n').slice(-12).map((l) => `      ${l}`).join('\n');
    return [
      `    attempt ${attempt}: pid ${proc.pid ?? 'none'}, phase "${phase}", ${Date.now() - started} ms since spawn` +
        (readyAt ? ` (ready after ${readyAt - started} ms)` : ''),
      `    process: ${exitInfo ? JSON.stringify(exitInfo) : 'still running'}; load average ${loadavg().map((n) => n.toFixed(1)).join(' ')} on ${cpus().length} CPUs`,
      `    Chrome stderr (last lines):\n${lines || '      (empty)'}`,
    ].join('\n');
  }

  async function close() {
    send('Browser.close').catch(() => {});
    await Promise.race([exited, delay(5000)]);
    if (!exitInfo) {
      proc.kill('SIGKILL');
      await Promise.race([exited, delay(5000)]);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }

  return { ready, evaluate, diagnostics, close, exitedEarly };
}

// Open the decoder page in headless Chrome and evaluate `expression` (which
// may return a promise) in it, returning the JSON value. Only the launch is
// retried (once); a failure after the page is ready fails immediately.
async function evaluateInChrome(expression) {
  const failures = [];
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    const chrome = startChrome(attempt);
    try {
      await withDeadline(Promise.race([chrome.ready(), chrome.exitedEarly]), LAUNCH_BUDGET_MS, 'Chrome launch');
    } catch (err) {
      failures.push(`  launch attempt ${attempt} failed: ${err.message}\n${chrome.diagnostics()}`);
      await chrome.close();
      continue;
    }
    try {
      return await withDeadline(Promise.race([chrome.evaluate(expression), chrome.exitedEarly]), DECODE_BUDGET_MS, 'Decoding in Chrome');
    } catch (err) {
      const earlier = failures.length ? `\n  (earlier launch failures:\n${failures.join('\n')})` : '';
      throw new Error(`${err.message} — after a successful launch on attempt ${attempt}; the decode is not retried\n${chrome.diagnostics()}${earlier}`);
    } finally {
      await chrome.close();
    }
  }
  throw new Error(`Chrome could not be launched (${LAUNCH_ATTEMPTS} attempts, ${LAUNCH_BUDGET_MS / 1000} s each):\n${failures.join('\n')}`);
}

describe('headless Chrome BarcodeDetector decodes the SVG', { skip: HAVE_CHROME ? false : `Chrome not found at ${CHROME}` }, () => {
  test('required URLs, a UTF-8 string, every forced mask, levels L/Q/H; qr.js also runs in the browser', { timeout: 200_000 }, async () => {
    assert.equal(URL_200.length, 200);
    assert.equal(new TextEncoder().encode(URL_200).length, 200);
    const cases = [
      { text: 'http://recipes.local' },
      { text: 'http://recipes.local:23456' },
      { text: URL_200 },
      { text: 'naïve café ☕' },
      ...Array.from({ length: 8 }, (_, mask) => ({ text: 'http://recipes.local:23456', opts: { mask } })),
      { text: 'http://recipes.local', opts: { ecc: 'L' } },
      { text: 'http://recipes.local', opts: { ecc: 'Q' } },
      { text: 'http://recipes.local', opts: { ecc: 'H' } },
      { text: URL_200.slice(0, 120) }, // version 7: exercises version information
    ];
    assert.equal(encode(URL_200).version, 10);
    const svgs = cases.map(({ text, opts }) => toSvg(encode(text, opts)));
    // Also load qr.js itself as an ES module inside Chrome (from a data: URL, as
    // file:// module imports are blocked) and encode the three required texts there.
    const required = cases.slice(0, 3).map((c) => c.text);
    const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(readFileSync(QR_SOURCE)).toString('base64');
    const { decoded, browserSvgs } = await evaluateInChrome(`(async () => {
      const qr = await import(${JSON.stringify(moduleUrl)});
      const browserSvgs = ${JSON.stringify(required)}.map((t) => qr.toSvg(qr.encode(t)));
      return { decoded: await window.decodeQr(${JSON.stringify(svgs)}), browserSvgs };
    })()`);
    cases.forEach(({ text, opts }, i) => {
      assert.deepEqual(decoded[i], [text], `case ${i} ${JSON.stringify(opts ?? {})}: ${text.slice(0, 40)}`);
    });
    assert.deepEqual(browserSvgs, svgs.slice(0, 3), 'the browser build of qr.js produces the same SVG as Node');
  });
});
