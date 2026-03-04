/**
 * Consolidated registry of known Solana DeFi program addresses.
 * Used for PDA whitelist (top-holders) and LP locker detection (liquidity).
 *
 * Sources: Jupiter /program-id-to-label, official docs, existing KNOWN_LOCKERS.
 */

// ---------------------------------------------------------------------------
// DEX / AMM Programs
// ---------------------------------------------------------------------------

const DEX_AMM_PROGRAMS: [string, string][] = [
  // Raydium
  ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Raydium AMM v4"],
  ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "Raydium CLMM"],
  ["CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "Raydium CPMM"],
  ["routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS", "Raydium Route"],
  // Orca
  ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Orca Whirlpool"],
  ["9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", "Orca v2"],
  // Meteora
  ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "Meteora DLMM"],
  ["Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", "Meteora Pools"],
  // Phoenix
  ["PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", "Phoenix"],
  // Lifinity
  ["2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c", "Lifinity v2"],
  // OpenBook
  ["srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX", "OpenBook v1"],
  ["opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EQMiAw", "OpenBook v2"],
  // GooseFX
  ["GFXsSL5sSaDfNFQUYsHekbWBW1TsFdjDYzACh62tEHxn", "GooseFX SSL"],
  // Aldrin
  ["CURVGoZn8zycx6FXwwevgBTB2gVvdbGTEpvMJDbgs2t4", "Aldrin v2"],
  // Crema
  ["CLMM9tUoggJu2wagPkkqs9eFG4BWhVBZWkP1qv3Sp7tR", "Crema"],
  // Invariant
  ["HyaB3W9q6XdA5xwpU4XnSZV94htfmbmqJXZcEbRaJutt", "Invariant"],
  // Marinade Finance (liquid staking — stake pool program + native staking)
  ["MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", "Marinade Finance"],
  // Saber
  ["SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ", "Saber"],
  // Mercurial
  ["MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky", "Mercurial"],
  // Penguin
  ["PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP", "Penguin"],
  // Symmetry
  ["2KehYt3KsEQR53jYcxjbQp2d2kCp4AkuQW68atufRwSr", "Symmetry"],
  // FluxBeam
  ["FLUXubRmkEi2q6K3Y2BDUk6NxFA98eTQDNqPECP7sMSC", "FluxBeam"],
  // Obric
  ["obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y", "Obric v2"],
  // Sanctum (LST routing)
  ["5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx", "Sanctum Router"],
  ["stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq", "Sanctum Infinity"],
  // Helium Network
  ["treaf4wWBBty3fHdyBpo35Mz84M8k3heKXmjmi9vFt8", "Helium Treasury"],
];

// ---------------------------------------------------------------------------
// Jupiter Programs
// ---------------------------------------------------------------------------

const JUPITER_PROGRAMS: [string, string][] = [
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "Jupiter v6"],
  ["JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", "Jupiter v4"],
  ["JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph", "Jupiter v3"],
  ["JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uN9CFi", "Jupiter v2"],
  ["jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu", "Jupiter Perps"],
  ["DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M", "Jupiter DCA"],
  ["JUP6i4ozu5ydDCnLiMogSckDPpbtr7BJ4FoIG79E9Rg5", "Jupiter Limit"],
];

// ---------------------------------------------------------------------------
// Pump.fun
// ---------------------------------------------------------------------------

const PUMP_PROGRAMS: [string, string][] = [
  ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "Pump.fun"],
  ["BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskCH9CKF3HBc", "Pump.fun (v2)"],
];

// ---------------------------------------------------------------------------
// Staking / LST Programs
// ---------------------------------------------------------------------------

const STAKING_PROGRAMS: [string, string][] = [
  ["SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy", "SPL Stake Pool"],
  ["6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS", "Jito Stake Pool"],
  ["3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM", "Marinade mSOL"],
  ["6WecYymEARvjG5ZyqkrVQ6YkhPfujNzWpSPwNKXHCbV2", "SolBlaze bSOL"],
  ["Stake11111111111111111111111111111111111111", "Native Stake Program"],
  ["StakeConfig11111111111111111111111111111111", "Stake Config"],
];

// ---------------------------------------------------------------------------
// Lending / Yield Programs
// ---------------------------------------------------------------------------

const LENDING_PROGRAMS: [string, string][] = [
  ["KLend2g3cP87ber8LQur5Nwxg2JqBukvz7jQTa9bVVH5", "Kamino Lending"],
  ["kvauTFR8qm1dhniz6pYuBZkuene3Hfrs1VQhVRgCNrr", "Kamino Vault"],
  ["MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA", "marginfi v2"],
  ["So1endDq2YkqhipRh3WViPa8hFSurrFpGo1GEhTAooUW", "Solend"],
  ["DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1", "Drift Lending"],
];

// ---------------------------------------------------------------------------
// Perps / Trading Programs
// ---------------------------------------------------------------------------

const PERPS_PROGRAMS: [string, string][] = [
  ["dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", "Drift Protocol"],
  ["ZETAxsqBRek56DhiGXrn75yj2NHU3aYUnxvHXpkf3aD", "Zeta Markets"],
  ["4MangoMjqJ2firMokCjjGPuH8rHomhRfDcyo4GXXKA", "Mango v4"],
  ["mv3ekLzLbnVPNxjSKvqBpU3ZeZXPQdEC3bp5MDEBG68", "Mango v3"],
];

// ---------------------------------------------------------------------------
// Governance Programs
// ---------------------------------------------------------------------------

const GOVERNANCE_PROGRAMS: [string, string][] = [
  ["GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw", "SPL Governance"],
  ["voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj", "Voter Stake Registry"],
  ["hvsrNC3NKbcryqDs2DocYHZ9yPKEVzdSjQG6RVtK1s8", "Helium VSR"],
  ["GnftV5kLjd67tvHpNGyodwWveEKivz3ZWvvE3Z4xi2iw", "Realms v3"],
];

// ---------------------------------------------------------------------------
// LP Locker Programs
// ---------------------------------------------------------------------------

const LP_LOCKER_PROGRAMS: [string, string][] = [
  // Streamflow
  ["strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m", "Streamflow"],
  // UNCX AMM V4
  ["UNCX77nZrA3TdAxMEggqG18xxpgiNGT6iqyynPwpoxN", "UNCX"],
  ["GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo", "UNCX"],
  ["DAtFFs2mhQFvrgNLA29vEDeTLLN8vHknAaAhdLEc4SQH", "UNCX"],
  // UNCX CPMM
  ["UNCXdvMRxvz91g3HqFmpZ5NgmL77UH4QRM4NfeL4mQB", "UNCX"],
  ["FEmGEWdxCBSJ1QFKeX5B6k7VTDPwNU3ZLdfgJkvGYrH5", "UNCX"],
  // UNCX CLMM
  ["UNCXrB8cZXnmtYM1aSo1Wx3pQaeSZYuF2jCTesXvECs", "UNCX"],
  ["GAYWATob4bqCj3fhVm8ZxoMSqUW2fb6e6SBQ7kk5qyps", "UNCX"],
  // UNCX general
  ["BzKincxjgFQjj4FmhaWrwHES1ekBGN73YesA7JwJJo7X", "UNCX"],
];

// ---------------------------------------------------------------------------
// Token Programs (system)
// ---------------------------------------------------------------------------

const TOKEN_SYSTEM_PROGRAMS: [string, string][] = [
  ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "SPL Token"],
  ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "Token-2022"],
  ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "Associated Token"],
  ["11111111111111111111111111111111", "System Program"],
];

// ---------------------------------------------------------------------------
// Exported Maps
// ---------------------------------------------------------------------------

/** All known DeFi program addresses → human-readable name */
export const KNOWN_DEFI_PROGRAMS = new Map<string, string>([
  ...DEX_AMM_PROGRAMS,
  ...JUPITER_PROGRAMS,
  ...PUMP_PROGRAMS,
  ...STAKING_PROGRAMS,
  ...LENDING_PROGRAMS,
  ...PERPS_PROGRAMS,
  ...GOVERNANCE_PROGRAMS,
  ...LP_LOCKER_PROGRAMS,
  ...TOKEN_SYSTEM_PROGRAMS,
]);

/** LP locker program subset (for liquidity.ts LP lock detection) */
export const KNOWN_LOCKERS = new Map<string, string>(LP_LOCKER_PROGRAMS);

/** Check if a program ID belongs to a known DeFi protocol */
export function isKnownDefiProgram(programId: string): boolean {
  return KNOWN_DEFI_PROGRAMS.has(programId);
}
