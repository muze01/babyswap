// utils/liquidity.ts
import * as anchor from "@coral-xyz/anchor";
import { BN } from 'bn.js';
import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    createInitializeMint2Instruction,
    MINT_SIZE,
    getMinimumBalanceForRentExemptMint,
    createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction,
    getAccount,
    NATIVE_MINT,
    createSyncNativeInstruction
} from '@solana/spl-token';
import { PublicKey, Connection, Keypair, Signer, Transaction, SystemProgram, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Soondex } from './instance';
import * as IDL from "./idl.json"
import { fetchPoolInfoDB } from "./fetchDB";
const YOUR_PROGRAM_ID = new PublicKey("4hfWrBXXKKYuQ91bjfAiccq3WTJjWkuYjiwuHK8Xmmmr");
import { insertPoolToDB } from "./fetchDB";
import { associatedAddress } from "@coral-xyz/anchor/dist/cjs/utils/token";
import { UserPoolData } from "@/pages";

export interface AddLiquidityParams {
    connection: Connection;
    wallet: anchor.Wallet;
    tokenAMint: PublicKey;
    tokenBMint: PublicKey;
    amountA: number;
    amountB: number;
    isNewPool: boolean;
    fee: string;
}

export interface RemoveLiquidityParam {
    connection: Connection;
    wallet: anchor.Wallet;
    liquidity: number;
    userPoolInfo: UserPoolData
}

interface TokenBalance {
    amount: number;
    decimals: number;
}

function percentageToBps(percentage: number): number {
    return Math.floor(percentage * 100);
}

export async function addLiquidity({
    connection,
    wallet,
    tokenAMint,
    tokenBMint,
    amountA,
    amountB,
    isNewPool,
    fee
}: AddLiquidityParams) {
    // if (!wallet.publicKey) throw new Error('Wallet not connected');
    // if (isNewPool) return;
    if (!tokenAMint || !tokenBMint || !amountA || !amountB || !wallet.publicKey) {
        throw new Error('Missing required parameters for swap');
    }

    try {
        // Create provider and program
        const provider = new anchor.AnchorProvider(
            connection,
            wallet,
            anchor.AnchorProvider.defaultOptions()
        );
    
        const program = new anchor.Program(IDL as unknown as Soondex, provider);

        // Check if pool exists
        const existingPool = await fetchPoolInfoDB(
            tokenAMint.toBase58(),
            tokenBMint.toBase58(),
            program as any
        );
        
        if (!existingPool) {
            throw new Error(`Pool Doesn't Exist`);
        }

        // Initialize all instructions array
        const instructions: TransactionInstruction[] = [];
        let cleanupInstructions: TransactionInstruction[] = [];

        // Handle Token A (check if it's SOL)
        let userTokenA: PublicKey;
        let scaledAmountA: anchor.BN;
        if (tokenAMint.equals(NATIVE_MINT)) {
            // Get SOL balance first
            const solBalance = await connection.getBalance(wallet.publicKey);
            const requiredLamports = scaleAmount(amountA, 9).toNumber(); // SOL has 9 decimals

            // Add some extra lamports for rent and fees (0.01 SOL should be safe)
            const extraLamports = 0.01 * LAMPORTS_PER_SOL;

            if (solBalance < requiredLamports + extraLamports) {
                throw new Error(
                    `Insufficient SOL balance for Token A. Required: ${amountA} SOL + 0.01 SOL for fees ` +
                    `(${(requiredLamports + extraLamports) / LAMPORTS_PER_SOL} SOL total), ` +
                    `Available: ${solBalance / LAMPORTS_PER_SOL} SOL`
                );
            }

            const {
                instructions:
                wsolInstructions,
                wsolAccount,
                cleanupInstruction
            } = await createWSOLAccountInstructionsFixed(
                connection,
                wallet.publicKey,
                requiredLamports
            );

            instructions.push(...wsolInstructions);
            if (cleanupInstruction)
                cleanupInstructions.push(cleanupInstruction);

            userTokenA = wsolAccount;
            scaledAmountA = new BN(requiredLamports); // Set scaled amount for SOL

        } else {
            const [ata, ix] = await createATAInstructionsIfNeeded(
                connection,
                wallet.publicKey,
                wallet.publicKey,
                tokenAMint
            );
            userTokenA = ata;

            // Check token A balance
            const tokenABalance = await checkAndGetTokenBalance(
                connection,
                userTokenA,
                tokenAMint,
                wallet.publicKey
            );
            const requiredAmount = scaleAmount(amountA, tokenABalance.decimals).toNumber();
            scaledAmountA = new BN(requiredAmount);

            if (ix) {
                instructions.push(ix);
            } else {

                if (tokenABalance.amount < requiredAmount) {
                    throw new Error(
                        `Insufficient balance for Token A. Required: ${amountA} ` +
                        `(${requiredAmount} base units), ` +
                        `Available: ${formatAmount(tokenABalance.amount, tokenABalance.decimals)} ` +
                        `(${tokenABalance.amount} base units)`
                    );
                }

            }
        }

        // Handle Token B (check if it's SOL)
        let userTokenB: PublicKey;
        let scaledAmountB: anchor.BN;
        if (tokenBMint.equals(NATIVE_MINT)) {
            // Get SOL balance if not already fetched (in case both tokens are SOL)
            const solBalance = await connection.getBalance(wallet.publicKey);
            const requiredLamports = scaleAmount(amountB, 9).toNumber(); // SOL has 9 decimals

            // Add some extra lamports for rent and fees (0.01 SOL should be safe)
            const extraLamports = 0.01 * LAMPORTS_PER_SOL;

            if (solBalance < requiredLamports + extraLamports) {
                throw new Error(
                    `Insufficient SOL balance for Token B. Required: ${amountB} SOL ` +
                    `${tokenAMint.equals(NATIVE_MINT) ? `+ ${amountA} SOL ` : ''}+ 0.01 SOL for fees ` +
                    `(${(requiredLamports + extraLamports) / LAMPORTS_PER_SOL} SOL total), ` +
                    `Available: ${solBalance / LAMPORTS_PER_SOL} SOL`
                );
            }

            const {
                instructions:
                wsolInstructions,
                wsolAccount,
                cleanupInstruction
            } = await createWSOLAccountInstructionsFixed(
                connection,
                wallet.publicKey,
                requiredLamports
            );

            instructions.push(...wsolInstructions);
            if (cleanupInstruction)
                cleanupInstructions.push(cleanupInstruction);

            userTokenB = wsolAccount;
            scaledAmountB = new BN(requiredLamports); // Set scaled amount for SOL

        } else {
            const [ata, ix] = await createATAInstructionsIfNeeded(
                connection,
                wallet.publicKey,
                wallet.publicKey,
                tokenBMint
            );
            userTokenB = ata;

            // Check token B balance
            const tokenBBalance = await checkAndGetTokenBalance(
                connection,
                userTokenB,
                tokenBMint,
                wallet.publicKey
            );
            const requiredAmount = scaleAmount(amountB, tokenBBalance.decimals).toNumber();
            scaledAmountB = new BN(requiredAmount);

            if (ix) {

                instructions.push(ix);
            } else {

                if (tokenBBalance.amount < requiredAmount) {
                    throw new Error(
                        `Insufficient balance for Token B. Required: ${amountB} ` +
                        `(${requiredAmount} base units), ` +
                        `Available: ${formatAmount(tokenBBalance.amount, tokenBBalance.decimals)} ` +
                        `(${tokenBBalance.amount} base units)`
                    );
                }
            }
        }
        
        // Derive necessary PDAs and accounts
        // const poolAddress = new PublicKey(existingPool.poolAddress);
        const [poolAddress] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("pool"),
                // tokenAMint.toBuffer(),
                tokenBMint.toBuffer()
            ],
            program.programId
        );
        const lpMint = new PublicKey(existingPool.lpMint);
        const poolTokenA = new PublicKey(existingPool.reserveAAccount);
        const poolTokenB = new PublicKey(existingPool.reserveBAccount);

        // Create user LP token account
        const [userLpTokenAccount, createUserLpTokenIx] = await createATAInstructionsIfNeeded(
            connection,
            wallet.publicKey,
            wallet.publicKey,
            lpMint
        );
        if (createUserLpTokenIx) instructions.push(createUserLpTokenIx);

        // Send transaction
        const tx = await program.methods
            .addLiquidity(scaledAmountA, scaledAmountB)
            .accounts({
                // pool: poolAddress,
                mintA: tokenAMint,
                mintB: tokenBMint,
                userTokenA,
                userTokenB,
                // poolTokenA,
                // poolTokenB,
                lpMint: lpMint,
                // userLpTokenAccount: userLpTokenAccount,
                user: wallet.publicKey,
                // systemProgram: anchor.web3.SystemProgram.programId,
                // tokenProgram: TOKEN_PROGRAM_ID,
                // associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                // rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            })
            .instruction();

        instructions.push(tx);

        // Add cleanup instructions at the end if any
        instructions.push(...cleanupInstructions);

        // Build and send transaction
        const transaction = new Transaction();
        instructions.forEach(ix => transaction.add(ix));

        const latestBlockhash = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = latestBlockhash.blockhash;
        transaction.feePayer = wallet.publicKey;


        // Sign with wallet
        const signedTransaction = await wallet.signTransaction(transaction);

        console.log("Sending transaction...");
        const signature = await connection.sendRawTransaction(
            signedTransaction.serialize(),
            {
                skipPreflight: true,
                maxRetries: 5,
                preflightCommitment: 'confirmed'
            }
        );

        const confirmation = await connection.confirmTransaction(
            {
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            },
            'confirmed'
        );

        if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        return tx;

    } catch (error) {
        console.error('Add Liquidity Error:', error);
        throw error;
    }
}

// First create a custom mint creation function that works with our wallet

// async function createMintWithWallet(
//     connection: Connection,
//     wallet: anchor.Wallet,
//     mintAuthority: PublicKey,
//     freezeAuthority: PublicKey | null,
//     decimals: number,
//     programId = TOKEN_PROGRAM_ID,
// ) {
//     const mintKeypair = Keypair.generate();
//     const lamports = await getMinimumBalanceForRentExemptMint(connection);

//     // Create the transaction
//     const transaction = new Transaction();

//     // Get the latest blockhash
//     const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
//     transaction.recentBlockhash = blockhash;
//     transaction.feePayer = wallet.publicKey;

//     // Add instructions
//     transaction.add(
//         SystemProgram.createAccount({
//             fromPubkey: wallet.publicKey,
//             newAccountPubkey: mintKeypair.publicKey,
//             space: MINT_SIZE,
//             lamports,
//             programId,
//         }),
//         createInitializeMint2Instruction(
//             mintKeypair.publicKey,
//             decimals,
//             mintAuthority,
//             freezeAuthority,
//             programId
//         )
//     );

//     // Sign with the mint keypair
//     transaction.sign(mintKeypair);
//     console.log("history created");

//     // Sign with wallet and send
//     const signedTx = await wallet.signTransaction(transaction);
//     const rawTransaction = signedTx.serialize();

//     // Send and confirm with proper confirmation strategy
//     const signature = await connection.sendRawTransaction(rawTransaction, {
//         skipPreflight: false,
//         preflightCommitment: 'confirmed'
//     });

//     // Wait for confirmation
//     const confirmation = await connection.confirmTransaction({
//         signature,
//         blockhash,
//         lastValidBlockHeight
//     });

//     console.log("Transaction Hash", signature);

//     if (confirmation.value.err) {
//         throw new Error(`Transaction failed: ${confirmation.value.err}`);
//     }


//     return mintKeypair.publicKey;
// }

// async function createWSOLAccountInstructions(
//     connection: Connection,
//     owner: PublicKey,
//     amount: number
// ): Promise<{
//     instructions: TransactionInstruction[],
//     wsolAccount: PublicKey,
//     cleanupInstruction: TransactionInstruction | null
// }> {
//     // const [wsolAccount] = PublicKey.findProgramAddressSync(
//     //     [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), NATIVE_MINT.toBuffer()],
//     //     ASSOCIATED_TOKEN_PROGRAM_ID
//     // );

//     const wsolAccount = associatedAddress({
//         mint: NATIVE_MINT,
//         owner: owner
//     })

//     const instructions: TransactionInstruction[] = [];
//     let cleanupInstruction: TransactionInstruction | null = null;

//     // Create WSOL account if it doesn't exist
//     try {
//         await connection.getAccountInfo(wsolAccount);
//     } catch {
//         instructions.push(
//             createAssociatedTokenAccountInstruction(
//                 owner,
//                 wsolAccount,
//                 owner,
//                 NATIVE_MINT
//             )
//         );
//     }

//     // Add SOL transfer and sync native instructions
//     instructions.push(
//         SystemProgram.transfer({
//             fromPubkey: owner,
//             toPubkey: wsolAccount,
//             lamports: amount
//         }),
//         createSyncNativeInstruction(wsolAccount)
//     );

//     // Create cleanup instruction to close WSOL account
//     cleanupInstruction = createCloseAccountInstruction(
//         wsolAccount,
//         owner,
//         owner
//     );

//     return { instructions, wsolAccount, cleanupInstruction };
// }

export async function checkAndGetTokenBalance(
    connection: Connection,
    tokenAccount: PublicKey,
    mint: PublicKey,
    owner: PublicKey
): Promise<TokenBalance> {
    try {
        const balance = await connection.getTokenAccountBalance(tokenAccount);
        return {
            amount: Number(balance.value.amount),
            decimals: balance.value.decimals
        };
    } catch (e) {
        console.log(e);
        // If account doesn't exist or error occurs, return zero balance
        return { amount: 0, decimals: 9 };
    }
}

export function scaleAmount(amount: number | string, decimals: number): anchor.BN {
    // Convert to string to handle precise decimal representation
    const amountStr = typeof amount === 'number' ? amount.toString() : amount;

    // Split into integer and decimal parts
    const [integerPart, decimalPart = ''] = amountStr.split('.');

    // Pad or truncate decimal part to match token decimals
    const paddedDecimalPart = decimalPart.padEnd(decimals, '0').slice(0, decimals);

    // Combine integer and decimal parts
    const fullScaledAmount = integerPart + paddedDecimalPart;

    // Convert to BN, removing leading zeros
    const scaledAmount = new BN(fullScaledAmount);

    console.log(`Scaling amount: ${amountStr} (${decimals} decimals) → ${scaledAmount.toString()} what came in was ${amount}`);

    return scaledAmount;
}

// Format base units to human readable amount
function formatAmount(amount: number, decimals: number): string {
    return (amount / Math.pow(10, decimals)).toFixed(decimals);
}

export async function createWSOLAccountInstructionsFixed(
    connection: Connection,
    owner: PublicKey,
    amount: number
): Promise<{
    instructions: TransactionInstruction[],
    wsolAccount: PublicKey,
    cleanupInstruction: TransactionInstruction | null
}> {
    // Get the associated token address for WSOL
    const wsolAccount = await getAssociatedTokenAddress(
        NATIVE_MINT,
        owner,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const instructions: TransactionInstruction[] = [];
    let cleanupInstruction: TransactionInstruction | null = null;

    // Check if the account exists
    const accountInfo = await connection.getAccountInfo(wsolAccount);

    // Create WSOL account if it doesn't exist
    if (!accountInfo) {
        instructions.push(
            createAssociatedTokenAccountInstruction(
                owner,                  // payer
                wsolAccount,            // ata
                owner,                  // owner
                NATIVE_MINT,            // mint
                TOKEN_PROGRAM_ID        // always use TOKEN_PROGRAM_ID
            )
        );
    }

    // Add SOL transfer
    instructions.push(
        SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: wsolAccount,
            lamports: amount
        })
    );

    // Add sync native instruction
    instructions.push(
        createSyncNativeInstruction(
            wsolAccount,
            TOKEN_PROGRAM_ID
        )
    );

    // Create cleanup instruction
    cleanupInstruction = createCloseAccountInstruction(
        wsolAccount,
        owner,
        owner,
        [],
        TOKEN_PROGRAM_ID              // explicitly specify TOKEN_PROGRAM_ID
    );

    return { instructions, wsolAccount, cleanupInstruction };
}

export async function removeLiquidity({
    connection,
    wallet,
    liquidity,
    userPoolInfo
}: RemoveLiquidityParam) {
    try {
        // Create provider
        const provider = new anchor.AnchorProvider(
            connection,
            wallet,
            anchor.AnchorProvider.defaultOptions()
        );

        // Initialize program
        const program = new anchor.Program(IDL as unknown as Soondex, provider);

        // Derive PDAs and get necessary accounts
        const [poolAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from("pool"), new PublicKey(userPoolInfo.info.tokenb).toBuffer()],
            program.programId
        );

        // Get token accounts
        const userLpTokenAccount = await getAssociatedTokenAddress(
            new PublicKey(userPoolInfo.info.lpmint),
            wallet.publicKey
        );

        const userTokenAAccount = await getAssociatedTokenAddress(
            new PublicKey(userPoolInfo.info.tokena),
            wallet.publicKey
        );

        const userTokenBAccount = await getAssociatedTokenAddress(
            new PublicKey(userPoolInfo.info.tokenb),
            wallet.publicKey
        );

        const poolTokenAAccount = await getAssociatedTokenAddress(
            new PublicKey(userPoolInfo.info.tokena),
            poolAuthority,
            true
        );

        const poolTokenBAccount = await getAssociatedTokenAddress(
            new PublicKey(userPoolInfo.info.tokenb),
            poolAuthority,
            true
        );

        // Fetch LP token account info to check current balance
        const lpTokenAccountInfo = await getAccount(
            connection,
            userLpTokenAccount
        );

        // Determine if user is removing all LP tokens
        const isRemovingAll = BigInt(liquidity) >= lpTokenAccountInfo.amount;

        // Prepare removal transaction
        const removeTx = await program.methods
            .removeLiquidity(new anchor.BN(liquidity))
            .accounts({
                mintA: new PublicKey(userPoolInfo.info.tokena),
                mintB: new PublicKey(userPoolInfo.info.tokenb),
                poolTokenA: poolTokenAAccount,
                poolTokenB: poolTokenBAccount,
                userLpTokenAccount,
                userTokenA: userTokenAAccount,
                userTokenB: userTokenBAccount,
                user: wallet.publicKey,
            })
            .instruction();

        // Create transaction
        const transaction = new Transaction().add(removeTx);

        // If removing all LP tokens, add instructions to close token accounts
        if (isRemovingAll) {
            // Close LP token account
            transaction.add(
                createCloseAccountInstruction(
                    userLpTokenAccount,
                    wallet.publicKey,
                    wallet.publicKey
                )
            );

            // Close token A account if balance is zero
            const tokenAAccountInfo = await getAccount(
                connection,
                userTokenAAccount
            );
            if (tokenAAccountInfo.amount === BigInt(0)) {
                transaction.add(
                    createCloseAccountInstruction(
                        userTokenAAccount,
                        wallet.publicKey,
                        wallet.publicKey
                    )
                );
            }

            // Close token B account if balance is zero
            const tokenBAccountInfo = await getAccount(
                connection,
                userTokenBAccount
            );
            if (tokenBAccountInfo.amount === BigInt(0)) {
                transaction.add(
                    createCloseAccountInstruction(
                        userTokenBAccount,
                        wallet.publicKey,
                        wallet.publicKey
                    )
                );
            }
        }

        // Complete transaction processing
        transaction.feePayer = wallet.publicKey;
        const latestBlockhash = await connection.getLatestBlockhash();
        transaction.recentBlockhash = latestBlockhash.blockhash;

        // Sign and send transaction
        const signedTx = await wallet.signTransaction(transaction);
        const signature = await connection.sendRawTransaction(
            signedTx.serialize(),
            {
                skipPreflight: true,
                maxRetries: 5,
                preflightCommitment: 'confirmed'
            }
        );

        // Wait for confirmation
        const confirmation = await connection.confirmTransaction(
            {
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            },
            'confirmed'
        );

        if (confirmation.value.err) {
            throw new Error('Transaction failed');
        }

        return {
            success: true,
            removedAll: isRemovingAll
        };
    } catch (error) {
        console.error("Error at Remove Liquidity", error);
        throw error;
    }
}

export async function addLiquidityNew({
    connection,
    wallet,
    tokenAMint,
    tokenBMint,
    amountA,
    amountB,
    isNewPool,
    fee
}: AddLiquidityParams) {
    if (!tokenAMint || !tokenBMint || !amountA || !wallet.publicKey || !fee || !amountB) {
        throw new Error('Missing required parameters');
    }
    try {
        
        const provider = new anchor.AnchorProvider(
            connection,
            wallet,
            anchor.AnchorProvider.defaultOptions()
        );
        
        const program = new anchor.Program(IDL as unknown as Soondex, provider);

        // Check if pool exists
        const existingPool = await fetchPoolInfoDB(
            tokenAMint.toBase58(),
            tokenBMint.toBase58(),
            program as any
        );
        
        if (existingPool) {
            throw new Error(`Pool already exists at address: ${existingPool.poolAddress}`);
        }
        
        // Initialize all instructions array
        const instructions: TransactionInstruction[] = [];
        let cleanupInstructions: TransactionInstruction[] = [];

        // Handle Token A (check if it's SOL)

        // if (tokenAMint.equals(NATIVE_MINT)) {
        //     throw new Error("token a is sol, not ideal")
        // }
        let userTokenA: PublicKey;
        let scaledAmountA: anchor.BN;
        if (tokenAMint.equals(NATIVE_MINT)) {
            // Get SOL balance first
            const solBalance = await connection.getBalance(wallet.publicKey);
            const requiredLamports = scaleAmount(amountA, 9).toNumber(); // SOL has 9 decimals

            // Add some extra lamports for rent and fees (0.01 SOL should be safe)
            const extraLamports = 0.01 * LAMPORTS_PER_SOL;

            if (solBalance < requiredLamports + extraLamports) {
                throw new Error(
                    `Insufficient SOL balance for Token A. Required: ${amountA} SOL + 0.01 SOL for fees ` +
                    `(${(requiredLamports + extraLamports) / LAMPORTS_PER_SOL} SOL total), ` +
                    `Available: ${solBalance / LAMPORTS_PER_SOL} SOL`
                );
            }

            const {
                instructions:
                wsolInstructions,
                wsolAccount,
                cleanupInstruction
            } = await createWSOLAccountInstructionsFixed (
                connection,
                wallet.publicKey,
                requiredLamports
            );

            instructions.push(...wsolInstructions);
            if (cleanupInstruction)
                cleanupInstructions.push(cleanupInstruction);

            userTokenA = wsolAccount;
            scaledAmountA = new BN(requiredLamports); // Set scaled amount for SOL

        } else {
            const [ata, ix] = await createATAInstructionsIfNeeded(
                connection,
                wallet.publicKey,
                wallet.publicKey,
                tokenAMint
            );
            userTokenA = ata;

            // Check token A balance
            const tokenABalance = await checkAndGetTokenBalance(
                connection,
                userTokenA,
                tokenAMint,
                wallet.publicKey
            );
            const requiredAmount = scaleAmount(amountA, tokenABalance.decimals).toNumber();
            scaledAmountA = new BN(requiredAmount);

            if (ix) {
                instructions.push(ix);
            } else {


                if (tokenABalance.amount < requiredAmount) {
                    throw new Error(
                        `Insufficient balance for Token A. Required: ${amountA} ` +
                        `(${requiredAmount} base units), ` +
                        `Available: ${formatAmount(tokenABalance.amount, tokenABalance.decimals)} ` +
                        `(${tokenABalance.amount} base units)`
                    );
                }

            }
        }

        // Handle Token B (check if it's SOL)
        let userTokenB: PublicKey;
        let scaledAmountB: anchor.BN;
        if (tokenBMint.equals(NATIVE_MINT)) {
            // Get SOL balance if not already fetched (in case both tokens are SOL)
            const solBalance = await connection.getBalance(wallet.publicKey);
            const requiredLamports = scaleAmount(amountB, 9).toNumber(); // SOL has 9 decimals

            // Add some extra lamports for rent and fees (0.01 SOL should be safe)
            const extraLamports = 0.01 * LAMPORTS_PER_SOL;

            if (solBalance < requiredLamports + extraLamports) {
                throw new Error(
                    `Insufficient SOL balance for Token B. Required: ${amountB} SOL ` +
                    `${tokenAMint.equals(NATIVE_MINT) ? `+ ${amountA} SOL ` : ''}+ 0.01 SOL for fees ` +
                    `(${(requiredLamports + extraLamports) / LAMPORTS_PER_SOL} SOL total), ` +
                    `Available: ${solBalance / LAMPORTS_PER_SOL} SOL`
                );
            }

            const {
                instructions:
                wsolInstructions,
                wsolAccount,
                cleanupInstruction
            } = await createWSOLAccountInstructionsFixed (
                connection,
                wallet.publicKey,
                requiredLamports
            );

            instructions.push(...wsolInstructions);
            if (cleanupInstruction)
                cleanupInstructions.push(cleanupInstruction);

            userTokenB = wsolAccount;
            scaledAmountB = new BN(requiredLamports); // Set scaled amount for SOL

        } else {
            const [ata, ix] = await createATAInstructionsIfNeeded(
                connection,
                wallet.publicKey,
                wallet.publicKey,
                tokenBMint
            );
            userTokenB = ata;

            // Check token B balance
            const tokenBBalance = await checkAndGetTokenBalance(
                connection,
                userTokenB,
                tokenBMint,
                wallet.publicKey
            );
            const requiredAmount = scaleAmount(amountB, tokenBBalance.decimals).toNumber();
            scaledAmountB = new BN(requiredAmount);

            if (ix) {

                instructions.push(ix);
            } else {

                if (tokenBBalance.amount < requiredAmount) {
                    throw new Error(
                        `Insufficient balance for Token B. Required: ${amountB} ` +
                        `(${requiredAmount} base units), ` +
                        `Available: ${formatAmount(tokenBBalance.amount, tokenBBalance.decimals)} ` +
                        `(${tokenBBalance.amount} base units)`
                    );
                }
            }
        }

        // Generate pool address
        const [poolAddress] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool'), tokenBMint.toBuffer()],
            program.programId
        );

        // Create LP Mint Account
        const mintKeypair = Keypair.generate();
        const mintRent = await getMinimumBalanceForRentExemptMint(connection);
        instructions.push(
            SystemProgram.createAccount({
                fromPubkey: wallet.publicKey,
                newAccountPubkey: mintKeypair.publicKey,
                space: MINT_SIZE,
                lamports: mintRent,
                programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeMint2Instruction(
                mintKeypair.publicKey,
                6,
                poolAddress,
                null,
                TOKEN_PROGRAM_ID
            )
        );

        // Create pool token accounts
        const [poolTokenA, createPoolTokenAIx] = await createATAInstructionsIfNeeded(
            connection,
            wallet.publicKey,
            poolAddress,
            tokenAMint
        );
        const [poolTokenB, createPoolTokenBIx] = await createATAInstructionsIfNeeded(
            connection,
            wallet.publicKey,
            poolAddress,
            tokenBMint
        );

        if (createPoolTokenAIx) instructions.push(createPoolTokenAIx);
        if (createPoolTokenBIx) instructions.push(createPoolTokenBIx);

        // Create user LP token account
        const [userLpToken, createUserLpTokenIx] = await createATAInstructionsIfNeeded(
            connection,
            wallet.publicKey,
            wallet.publicKey,
            mintKeypair.publicKey
        );
        if (createUserLpTokenIx) instructions.push(createUserLpTokenIx);

        // Add pool initialization instruction
        const feeCon = percentageToBps(Number(fee));
        const initializePoolIx = await program.methods
            .initializePool(new BN(feeCon))
            .accounts({
                // pool: poolAddress,
                mintA: tokenAMint,
                mintB: tokenBMint,
                // poolTokenA,
                // poolTokenB,
                user: wallet.publicKey,
                // systemProgram: anchor.web3.SystemProgram.programId,
                // tokenProgram: TOKEN_PROGRAM_ID,
                // associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                // rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            })
            .instruction();

        instructions.push(initializePoolIx);        

        // Add liquidity instruction
        const addLiquidityIx = await program.methods
            .addLiquidity(scaledAmountA, scaledAmountB)
            .accounts({
                // pool: poolAddress,
                mintA: tokenAMint,
                mintB: tokenBMint,
                userTokenA,
                userTokenB,
                // poolTokenA,
                // poolTokenB,
                lpMint: mintKeypair.publicKey,
                // userLpTokenAccount: userLpToken,
                user: wallet.publicKey,
                // systemProgram: anchor.web3.SystemProgram.programId,
                // tokenProgram: TOKEN_PROGRAM_ID,
                // associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                // rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            })
            .instruction();

        instructions.push(addLiquidityIx);

        // Add cleanup instructions at the end if any
        instructions.push(...cleanupInstructions);

        // Build and send transaction
        const transaction = new Transaction();
        instructions.forEach(ix => transaction.add(ix));

        const latestBlockhash = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = latestBlockhash.blockhash;
        transaction.feePayer = wallet.publicKey;

        // Sign with mint keypair
        transaction.partialSign(mintKeypair);

        // Sign with wallet
        const signedTransaction = await wallet.signTransaction(transaction);

        console.log("Sending transaction...");
        const signature = await connection.sendRawTransaction(
            signedTransaction.serialize(),
            {
                skipPreflight: true,
                maxRetries: 5,
                preflightCommitment: 'confirmed'
            }
        );

        // Wait for confirmation
        const confirmation = await connection.confirmTransaction(
            {
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            },
            'confirmed'
        );

        if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        // Update pool data if successful
        if (isNewPool) {
            const poolData = {
                pool: poolAddress.toString(),
                lpmint: mintKeypair.publicKey.toBase58(),
                tokena: tokenAMint.toBase58(),
                tokenaamount: scaledAmountA.toString(),
                tokenb: tokenBMint.toBase58(),
                tokenbamount: scaledAmountB.toString(),
                deployer: wallet.publicKey.toBase58(),
                tvl: 0,
                fee: Number(fee),
                created: new Date()
            };
            await insertPoolToDB(poolData);
        }

        console.log("Congratulations...");
        return signature;

    } catch (error) {
        console.error('Error in addLiquidityNew:', error);
        throw error;
    }
}

export async function createATAInstructionsIfNeeded(
    connection: Connection,
    payer: PublicKey,
    owner: PublicKey,
    mint: PublicKey
): Promise<[PublicKey, TransactionInstruction | null]> {
    const ata = associatedAddress({
        mint: mint,
        owner: owner
    });
    let instruction: TransactionInstruction | null = null;

    try {
        const account = await connection.getAccountInfo(ata);
        if (!account) {
            instruction = createAssociatedTokenAccountInstruction(
                payer,
                ata,
                owner,
                mint
            );
        }
    } catch (error) {
        console.error(`Error checking ATA: ${error}`);
        throw error;
    }

    return [ata, instruction];
}