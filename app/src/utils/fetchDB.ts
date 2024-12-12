import { executeQuery } from "./db";
import { SystemProgram, Keypair, Connection, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from '@coral-xyz/anchor';
import { createMint, TOKEN_PROGRAM_ID, createMintToInstruction, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, mintTo, getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import BN from "bn.js";
// import { IDL } from './try'
import { associatedAddress } from "@coral-xyz/anchor/dist/cjs/utils/token";
const YOUR_PROGRAM_ID = new PublicKey("9KbmGkC46fTWnrSeyBr1Zcdnyw2TXFDxuyRW2LPdr9R9");

interface PoolInfo {
    poolAddress: string;
    tokenAMint?: string;
    tokenBMint?: string;
    reserveAAccount: string;
    reserveBAccount: string;
    fee?: number;
}

type PoolData = {
    pool: string; 
    lpmint: string,
    tokena: string,
    tokenaamount: string,
    tokenb: string,
    tokenbamount: string,
    deployer: string,
    tvl: number;   
    fee: number;  
    created: Date; 
};

export type TradeData = {
    player: string,
    amount: number,
    mint: string,
    pool: string,
}

export async function fetchPoolInfoDB(
    fromMint: string,
    toMint: string,
    program: Program
) {
   
    const [poolPDA1] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool'), new PublicKey(fromMint).toBuffer()],
        program.programId
    );

    const [poolPDA2] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool'), new PublicKey(toMint).toBuffer()],
        program.programId
    );

    // console.log("from Mint", fromMint, "to mint", toMint);
    // console.log("poolPDA1 ", poolPDA1.toBase58(), poolPDA2.toBase58());
    const query = 'SELECT * FROM pools WHERE pool = $1 OR pool = $2';
    const values = [poolPDA1.toBase58(), poolPDA2.toBase58()];

    try {
        const result = await executeQuery(query, values);

        // console.log('=================😃 Fetched Fetch Function 😃=================', result[0]);

        if (!result || result.length === 0) {
            console.log("we're going back man");
            return null;
        }

        const poolInfo = result[0];
        const { pool, info } = poolInfo;

        const { lpmint, fee, tokena, tokenb } = info;

        const poolReserveA = associatedAddress({
            mint: new PublicKey(fromMint),
            owner: new PublicKey(pool)
        });

        const poolReserveB = associatedAddress({
            mint: new PublicKey(toMint),
            owner: new PublicKey(pool)
        });

        return {
            poolAddress: pool,
            lpMint: lpmint,
            tokena,
            tokenb,
            reserveAAccount: poolReserveA.toBase58(),
            reserveBAccount: poolReserveB.toBase58(),
            fee: fee
        };

    } catch (error) {
        console.error('Error fetching pool info:', error);
        // return null;
        throw error;
    }
}

// Function to insert pool data into the database
export async function insertPoolToDB(poolData: PoolData) {
    try {
        const query = `
      INSERT INTO pools (pool, info)
      VALUES ($1, $2)
      RETURNING *;
    `;

        const info = {

            Tvl: poolData.tvl,
            fee: poolData.fee,
            lpmint: poolData.lpmint,
            tokena: poolData.tokena,
            tokenaamount: poolData.tokenaamount,
            tokenb: poolData.tokenb,
            tokenbamount: poolData.tokenbamount,
            deployer: poolData.deployer,
            created: poolData.created
        };

        const values = [
            poolData.pool,
            info
        ];

        const result = await executeQuery(query, values);
        // return result.rows[0]; NOT NEEDED.
    } catch (error) {
        console.error('Error inserting pool data:', error);
        throw error;
    }
}

// Function to insert pool data into the database
export async function insertTradeToDB(tradeData: TradeData) {
    try {
        const query = `
      INSERT INTO trade (mint, pool, info)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;

        const info = {
            player: tradeData.player,
            amount: tradeData.amount,
        };

        const values = [
            tradeData.mint,
            tradeData.pool,
            info
        ];

        const result = await executeQuery(query, values);

    } catch (error) {
        console.error('Error inserting trade data:', error);
        throw error;
    }
}

export async function fetchLiquidity(userAddress: string) {
    try {
        console.log("GET THE FUCK BACK");
        
        const query = `SELECT * FROM pools WHERE info->>'deployer' = $1`;
        const value = [userAddress]
        const result = await executeQuery(query, value);

        if (!result || result.length === 0) {
            console.log("USER DOESN'T HAVE LP MINTS");
            return null;
        }
        // console.log("User Lp Info ", result);
        // console.log("User Lp Info INNER ", result[0]);
        
        // const poolInfo = result[0];
        // const { pool, info } = poolInfo;

        return result;

    } catch (error) {
        console.error("Error Fetching User Liquidity Info", error);
    }
}