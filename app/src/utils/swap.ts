import { SystemProgram, Keypair, Connection, Transaction, PublicKey, LAMPORTS_PER_SOL, TransactionInstruction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from '@coral-xyz/anchor';
import { createMint, TOKEN_PROGRAM_ID, createMintToInstruction, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, mintTo, getAccount, getAssociatedTokenAddress, NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { associatedAddress } from "@coral-xyz/anchor/dist/cjs/utils/token";
import { Soondex } from './instance';
import * as IDL from "./idl.json"
import { fetchPoolInfoDB, insertTradeToDB } from "./fetchDB";
import { checkAndGetTokenBalance, createATAInstructionsIfNeeded, createWSOLAccountInstructionsFixed, scaleAmount } from "./liquidity";

// const program = new anchor.Program(IDL as unknown as Soondex, provider);

export interface SwapParams {
    connection: Connection,
    fromToken: PublicKey;
    toToken: PublicKey;
    fromAmount: number;
    // toAmount: number;
    slippage: number;
    wallet: anchor.Wallet; 
    // pools: any[]; 
}

export async function getTokenBalance(
    connection: Connection,
    walletAddress: PublicKey,
    tokenMint: string
): Promise<number> {
    try {
        if (tokenMint === 'So11111111111111111111111111111111111111112') {
            const balance = await connection.getBalance(walletAddress);
            return balance / LAMPORTS_PER_SOL;
        }

        const tokenMintPubkey = new PublicKey(tokenMint);
        const ata = await connection.getTokenAccountsByOwner(walletAddress, {
            mint: tokenMintPubkey,
            programId: TOKEN_PROGRAM_ID,
        });

        if (ata.value.length === 0) {
            return 0;
        }

        const balance = await connection.getTokenAccountBalance(ata.value[0].pubkey);
        console.log("this is the real balance? ", balance.value.uiAmountString, balance.value.uiAmount);
        
        return Number(balance.value.uiAmount);
    } catch (error) {
        console.error('Error fetching token balance:', error);
        return 0;
    }
}

export function formatBalance(balance: number | null, options?: {
    showFullPrecision?: boolean;
    compactThreshold?: number;
}): string {
    const {
        showFullPrecision = true,
        compactThreshold = 0.001
    } = options || {};

    if (balance === null) return '0';
    if (balance === 0) return '0';

    // If showFullPrecision is true, always show full balance
    if (showFullPrecision) {
        return balance.toString();
    }

    // If balance is very small
    if (balance < compactThreshold) {
        return `< ${compactThreshold}`;
    }

    // For larger balances
    if (balance >= 1) {
        return balance.toLocaleString(undefined, {
            maximumFractionDigits: 3,
            minimumFractionDigits: 0
        });
    }

    // For small but significant balances
    return balance.toLocaleString(undefined, {
        maximumFractionDigits: 6,
        minimumFractionDigits: 0
    });
}

interface PoolInfo {
    poolAddress: string;
    tokenAMint?: string;
    tokenBMint?: string;
    reserveAAccount: string;
    reserveBAccount: string;
    fee?: number;
}

interface PoolReserves {
    TokenAReserve: BN;
    TokenBReserve: BN;
}

export async function estimateSwapAmount(
    connection: Connection,
    fromMint: string,
    toMint: string,
    fromAmount: number | string,
    slippagePercent: number = 0.5, // default 0.5%
    wallet: anchor.Wallet
): Promise<{
    estimatedOutput: number,
    minimumReceived: number
}> {
    if (!fromMint || !toMint || Number(fromAmount) <= 0) {
        return {
            estimatedOutput: 0,
            minimumReceived: 0
        };
    }

    if (fromMint === toMint) {
        return {
            estimatedOutput: Number(fromAmount),
            minimumReceived: Number(fromAmount)
        };
    }

    try {

        const provider = new anchor.AnchorProvider(
            connection,
            wallet,
            anchor.AnchorProvider.defaultOptions()
        );
        const program = new anchor.Program(IDL as unknown as Soondex, provider);

        const poolInfo = await fetchPoolInfoDB(
            fromMint,
            toMint,
            program as any
        );

        if (!poolInfo) {
            throw new Error('No pool found for the given token pair');
        }

        const poolReserves = await fetchPoolReserves(
            connection,
            poolInfo.reserveAAccount,
            poolInfo.reserveBAccount
        );

        const rawOutputAmount = await simulateSwap(
            fromAmount,
            poolReserves,
            slippagePercent,
            poolInfo.fee || 0,
            fromMint
        );

        const minimumReceived = rawOutputAmount.mul(
            new BN(100 - slippagePercent).mul(new BN(100))
        ).div(new BN(10000));

        // const priceImpact = calculatePriceImpact(
        //     new BN(fromAmount),
        //     rawOutputAmount,
        //     poolReserves
        // );

        // Corrected logic for scaling amounts
        const isSo1111111111 = fromMint === "So11111111111111111111111111111111111111112";
        const scalingFactor = isSo1111111111 ? Math.pow(10, 9) : Math.pow(10, 6);

        const estimatedOutput = Number(rawOutputAmount.toString()) / scalingFactor;
        const minReceived = Number(minimumReceived.toString()) / scalingFactor;
        // const estimatedOutput = Number(rawOutputAmount.toString());
        // const minReceived = Number(minimumReceived.toString());

        console.log("scaling factor", isSo1111111111, estimatedOutput, minReceived);
        
        return {
            estimatedOutput: estimatedOutput, 
            // priceImpact: priceImpact,
            minimumReceived: minReceived
        };

    } catch (error) {
        console.error('Swap estimation error:', error);
        return {
            estimatedOutput: 0,
            minimumReceived: 0
        };
    }
}

async function fetchPoolReserves(
    connection: Connection,
    reserveAAccount: string,
    reserveBAccount: string
): Promise<PoolReserves> {
    const reserveAInfo = await connection.getTokenAccountBalance(
        new PublicKey(reserveAAccount)
    );

    const reserveBInfo = await connection.getTokenAccountBalance(
        new PublicKey(reserveBAccount)
    );
    console.log("reserve a and b ", reserveAInfo.value.uiAmount, reserveBInfo.value.uiAmount);
    
    return {
        TokenAReserve: new BN(reserveAInfo.value.amount),
        TokenBReserve: new BN(reserveBInfo.value.amount)
    };
}

async function simulateSwap(
    buyAmount: number | string,
    poolReserves: PoolReserves,
    slippagePercent: number,
    feePercent: number,
    fromMint: string
): Promise<BN> {
    // If buyAmount is zero or poolReserves is not provided, return 0
    console.log(" Token A and B reserve and FEE and BUYAMOUNT", poolReserves.TokenAReserve.toString(), poolReserves.TokenBReserve.toString(), feePercent, buyAmount);
    
    if (Number(buyAmount) === 0 || !poolReserves) {
        return new BN(0);
    }

    // Corrected logic for scaling amounts
    const isSo1111111111 = fromMint === "So11111111111111111111111111111111111111112";
    const scalingFactor = isSo1111111111 ? Math.pow(10, 9) : Math.pow(10, 6);
    const roundedAmount = Math.round(Number(buyAmount));

    console.log("rounded amount", roundedAmount.toString())
    // Convert inputs to BN instances
    const buyAmountBN = new BN(roundedAmount).mul(new BN(scalingFactor));
    console.log("buy amount bn and number", buyAmountBN, buyAmountBN.toString());
    
    // Apply trading fee
    const feeAmount = buyAmountBN.mul(new BN(feePercent * 10)).div(new BN(1000));
    const amountAfterFee = buyAmountBN.sub(feeAmount);

    // Extract reserves from the pool
    const initialTokenAReserve = poolReserves.TokenAReserve;
    const initialTokenBReserve = poolReserves.TokenBReserve;

    // Calculate the product constant (K)
    const constantProductK = initialTokenAReserve.mul(initialTokenBReserve);

    // Calculate the new reserve for Token A after the buy
    const newTokenAReserve = initialTokenAReserve.add(amountAfterFee);

    // Calculate the new Token B reserve and the output amount
    const newTokenBReserve = constantProductK.div(newTokenAReserve);
    const rawOutputAmount = initialTokenBReserve.sub(newTokenBReserve);

    return rawOutputAmount;
}

// Calculate price impact
// function calculatePriceImpact(
//     inputAmount: BN,
//     outputAmount: BN,
//     poolReserves: PoolReserves
// ): number {
//     const initialPrice = poolReserves.TokenBReserve.div(poolReserves.TokenAReserve);
//     const expectedOutputWithoutImpact = inputAmount.mul(initialPrice);

//     const priceImpactRaw = expectedOutputWithoutImpact.sub(outputAmount)
//         .mul(new BN(10000))
//         .div(expectedOutputWithoutImpact);
//     console.log(initialPrice.toString(), expectedOutputWithoutImpact.toString(), priceImpactRaw.toString());
    
//     return Number(priceImpactRaw.toString()) / 100; // Convert to percentage
// }

// Determine the swap direction based on pool configuration
const determineSwapDirection = (
    tokena: PublicKey,
    tokenb: PublicKey,
    fromMint: PublicKey,
): boolean => {

    // Check if fromMint matches tokenA in the pool
    if (tokena.equals(fromMint)) {
        console.log("THIS IS A BUY TRANSACTION !");
        return true;
    } else if (tokenb.equals(fromMint)) {
        console.log("THIS IS A SELL TRANSACTION !");
        return false;
    }
    throw new Error('Invalid pool for selected tokens');
};

export const Swap = async ({
    connection,
    fromToken,
    toToken,
    fromAmount,
    // toAmount,
    slippage,
    wallet,
}: SwapParams) => {
    if (!fromToken || !toToken || !fromAmount || !wallet.publicKey) {
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
        
        const existingPool = await fetchPoolInfoDB(
            fromToken.toBase58(),
            toToken.toBase58(),
            program as any
        );
        console.log(existingPool);
        
        if (!existingPool) {
            throw new Error(`Pool doesn't exists`);
        }

        // Initialize instructions array
        const instructions: TransactionInstruction[] = [];
        let cleanupInstructions: TransactionInstruction[] = [];

        // Handle from token (input token)
        let userFromToken: PublicKey;
        let scaledFromAmount: anchor.BN;

        if (fromToken.equals(NATIVE_MINT)) {
            // Handle SOL input
            const solBalance = await connection.getBalance(wallet.publicKey);
            const requiredLamports = scaleAmount(fromAmount, 9).toNumber();
            const extraLamports = 0.01 * LAMPORTS_PER_SOL;

            if (solBalance < requiredLamports + extraLamports) {
                throw new Error(
                    `Insufficient SOL balance. Required: ${fromAmount} SOL + 0.01 SOL for fees`
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

            userFromToken = wsolAccount;
            scaledFromAmount = new BN(requiredLamports);
        } else {
            // Handle SPL token input
            const [ata, ix] = await createATAInstructionsIfNeeded(
                connection,
                wallet.publicKey,
                wallet.publicKey,
                fromToken
            );
            userFromToken = ata;

            const tokenBalance = await checkAndGetTokenBalance(
                connection,
                userFromToken,
                fromToken,
                wallet.publicKey
            );

            const requiredAmount = scaleAmount(fromAmount, tokenBalance.decimals); // Keep as BN
            console.log("required Amount ", requiredAmount.toString(), "|| tokenBalance ", tokenBalance.amount.toString());
            scaledFromAmount = requiredAmount;
            
            if (ix) {
                instructions.push(ix);
            } else if (requiredAmount.gt(new BN(tokenBalance.amount))) {
                throw new Error(
                    `Insufficient balance for input token. Required: ${fromAmount}`
                );
            }
        }

        // Handle to token (output token)
        let userToToken: PublicKey;

        if (toToken.equals(NATIVE_MINT)) {
            const {
                instructions: wsolInstructions,
                wsolAccount,
                cleanupInstruction
            } = await createWSOLAccountInstructionsFixed(
                connection,
                wallet.publicKey,
                0 // We don't need to wrap any SOL for receiving
            );

            instructions.push(...wsolInstructions);
            if (cleanupInstruction) cleanupInstructions.push(cleanupInstruction);

            userToToken = wsolAccount;
        } else {
            const [ata, ix] = await createATAInstructionsIfNeeded(
                connection,
                wallet.publicKey,
                wallet.publicKey,
                toToken
            );
            userToToken = ata;
            if (ix) instructions.push(ix);
        }

        const tokena = new PublicKey(existingPool.tokena);
        const tokenb = new PublicKey(existingPool.tokenb);
        const poolAddress = new PublicKey(existingPool.poolAddress);
        const feeCollector = new PublicKey("nktzW8vT4Fzaegd2qqgf24ZPLf11yDVdfEvfbkB4FQz");

        const is_buy = determineSwapDirection(tokena, tokenb, fromToken)

        const swapMethod = is_buy ? program.methods.buy : program.methods.sell;

        // Create swap instruction
        const slippageBps = percentageToBps(slippage);
        const swapInstructionData = {
            amount: scaledFromAmount,
            slippage: new BN(slippageBps),
            isBuy: is_buy
        };

        const swapIx = await 
        swapMethod(swapInstructionData)
            .accounts({
                // feeCollector: feeCollector,
                // pool: poolAddress,
                // mintA: fromToken,
                // mintB: toToken,
                mintA: fromToken,
                mintB: toToken,
                // poolTokenAAta: poolTokenA,
                // poolTokenBAta: poolTokenB,
                // userTokenAAta: userFromToken,
                // userTokenBAta: userToToken,
                user: wallet.publicKey,
                // rent: anchor.web3.SYSVAR_RENT_PUBKEY,
                // systemProgram: anchor.web3.SystemProgram.programId,
                // tokenProgram: TOKEN_PROGRAM_ID,
                // associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            })
            .instruction();

        instructions.push(swapIx);
        instructions.push(...cleanupInstructions);

        // Build and send transaction
        const transaction = new Transaction();
        instructions.forEach(ix => transaction.add(ix));
        
        const latestBlockhash = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = latestBlockhash.blockhash;
        transaction.feePayer = wallet.publicKey;
        
        // logInstructionKeys(instructions, connection, wallet);
        // Sign and send transaction
        const signedTransaction = await wallet.signTransaction(transaction);
        // Simulate before sending
        // const simulation = await connection.simulateTransaction(transaction);
        // console.log('Simulation results:', simulation);
        // console.log("Sending swap transaction...");

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
            throw new Error(`Transaction failed: ${confirmation.value.err}`);
        }

        const tradeData = {
            player: wallet.publicKey.toBase58(),
            amount: Number(fromAmount),
            mint: fromToken.toBase58(), // TODO ADD TO TOKEN ALSO, VERY IMPORTANT.....
            pool: poolAddress.toBase58()
        }
        await insertTradeToDB(tradeData);

        return signature;

    } catch (error) {
        console.error('Swap failed:', error);
        throw error;
    }
};

// const logInstructionKeys = (instructions: TransactionInstruction[], connection: Connection, wallet: anchor.Wallet) => {
//     console.log('===== INSTRUCTION KEYS DETAILED LOGGING =====');

//     instructions.forEach((ix, instructionIndex) => {
//         console.log(`\n🔍 Instruction #${instructionIndex}:`);
//         console.log(`Program ID: ${ix.programId.toBase58()}`);

//         ix.keys.forEach((key, keyIndex) => {
//             console.log(`\n  Key #${keyIndex}:`, {
//                 pubkey: key.pubkey.toBase58(),
//                 isSigner: key.isSigner,
//                 isWritable: key.isWritable
//             });

//             try {
//                 // Additional context for known accounts
//                 if (key.pubkey.equals(wallet.publicKey)) {
//                     console.log('   💡 This is the user/wallet public key');
//                 }

//                 // Try to get account info for more context
//                 connection.getAccountInfo(key.pubkey)
//                     .then(accountInfo => {
//                         if (accountInfo) {
//                             console.log('   📊 Account Info:', {
//                                 owner: accountInfo.owner.toBase58(),
//                                 lamports: accountInfo.lamports,
//                                 dataLength: accountInfo.data.length
//                             });
//                         }
//                     })
//                     .catch(err => {
//                         console.log('   ❌ Could not fetch account info:', err.message);
//                     });
//             } catch (error) {
//                 console.log('   ❌ Error fetching additional account details');
//             }
//         });
//     });

//     console.log('\n===== END OF INSTRUCTION KEYS LOGGING =====');
// };

function percentageToBps(percentage: number): number {
    return Math.floor(percentage * 100);
}

export interface SwapEstimation {
    estimatedOutput: number;
    // priceImpact: number;
    minimumReceived: number;
}