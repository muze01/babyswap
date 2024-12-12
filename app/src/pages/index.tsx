"use client";
import React, { useState, useEffect, useMemo } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Toaster, toast } from 'sonner';
import dynamic from "next/dynamic";
import { pool } from '../db/index';
import TokenModal from "./TokenModal";
import { GetServerSideProps } from "next";
import { getTokenBalance, formatBalance, Swap } from '../utils/swap';
import { estimateSwapAmount, SwapEstimation } from '../utils/swap';
import { addLiquidity, addLiquidityNew, removeLiquidity } from "@/utils/liquidity";
import * as anchor from "@coral-xyz/anchor";
import { WalletContextState } from '@solana/wallet-adapter-react';
// import { IDL } from "";
import { fetchLiquidity, fetchPoolInfoDB } from "@/utils/fetchDB";
import { SwapParams } from "../utils/swap";
import PoolSelectionModal, { TokenIconProps } from "./PoolSelectionModal";

interface TokenInfo {
  name: string
  time?: number
  image: string
  symbol: string
  poolAta: string
  website: string | null
  poolAddress: string
  twitterLink: string | null
  telegramLink: string | null
  // metadataAddress: string
}

// Extended PoolData type to include additional removal-specific properties
export interface UserPoolData extends PoolData {
  lpBalance: string;
  liquidityToRemove: string;
  estimatedTokenAReturn: string;
  estimatedTokenBReturn: string;
}

export interface PoolInfo {
  pool: string,
  symbol: string,
  lpmint: string,
  tokena: string,
  tokenb: string,
  tvl: number;
  fee: number;
  created: string;
}

export interface MintData {
  mint: string;
  info: TokenInfo;
}

export interface PoolData {
  pool: string;
  info: PoolInfo;
}

interface PageProps {
  mints: MintData[];
  pools: PoolData[];
}

export const SOL_TOKEN_INFO: { mint: string, info: TokenInfo } = {
  mint: "So11111111111111111111111111111111111111112", // SOL's mint address
  info: {
    name: "Solana",
    symbol: "SOL",
    image: "https://s2.coinmarketcap.com/static/img/coins/64x64/16116.png",
    poolAddress: "",
    poolAta: "",
    website: "https://solana.com",
    twitterLink: "https://twitter.com/solana",
    telegramLink: null,
    // metadataAddress: "",
  }
};

const WalletMultiButtonDynamic = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

export default function Page({ mints, pools }: PageProps) {
  const { connection } = useConnection();
  const { publicKey, wallet, signTransaction } = useWallet();
  const walletContext = useWallet();
  const anchorWallet = useAnchorWallet()

  const [balance, setBalance] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState("swap");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [selectedTokenFrom, setSelectedTokenFrom] = useState<{ mint: string, info: TokenInfo } | null>(SOL_TOKEN_INFO);
  const [selectedTokenTo, setSelectedTokenTo] = useState<{ mint: string, info: TokenInfo } | null>(null);
  const [modalType, setModalType] = useState<'from' | 'to'>('from');
  const [fromTokenBalance, setFromTokenBalance] = useState<number | null>(null);
  const [toTokenBalance, setToTokenBalance] = useState<number | null>(null);
  const [slippage, setSlippage] = useState(0.5);
  const [fromAmount, setFromAmount] = useState<string>('');
  const [toAmount, setToAmount] = useState<string>('');
  const [swapEstimation, setSwapEstimation] = useState<SwapEstimation | null>(null);
  const [poolFee, setPoolFee] = useState('0');

  // Add Liquidity specific state
  const [tokenAMint, setTokenAMint] = useState<{ mint: string, info: TokenInfo } | null>(null);
  const [tokenBMint, setTokenBMint] = useState<{ mint: string, info: TokenInfo } | null>(SOL_TOKEN_INFO);
  const [tokenAAmount, setTokenAAmount] = useState<string>('');
  const [tokenBAmount, setTokenBAmount] = useState<string>('');
  const [tokenABalance, setTokenABalance] = useState<number | null>(null);
  const [tokenBBalance, setTokenBBalance] = useState<number | null>(null);
  const [isNewPool, setIsNewPool] = useState(false);

  // Remove Lp state
  const [isPoolModalOpen, setIsPoolModalOpen] = useState(false);
  const [selectedPool, setSelectedPool] = useState<PoolData | null>(null);
  const [liquidityToRemove, setLiquidityToRemove] = useState('');
  const [lpTokenBalance, setLpTokenBalance] = useState('0');
  const [estimatedTokenAReturn, setEstimatedTokenAReturn] = useState('0');
  const [estimatedTokenBReturn, setEstimatedTokenBReturn] = useState('0');


  // State Management
  const [isLoading, setIsLoading] = useState(false);
  const [userPools, setUserPools] = useState<UserPoolData[]>([]);


  const handleFetchUserPools = async () => {
    if (!publicKey) return;

    setIsLoading(true);
    try {
      const poolsData = await fetchLiquidity(publicKey.toBase58());

      // No pools found
      if (!poolsData || poolsData.length === 0) {
        toast.warning('No Liquidity Pools', {
          description: 'Try adding liquidity to a pool.',
          className: 'toast-warning'
        });
        setUserPools([]);
        return;
      }

      // Transform and process pools
      const enrichedPools = await Promise.all(
        poolsData.map(async (pool: { info: { lpmint: string; }; }) => {
          const lpBalance = await getTokenBalance(
            connection,
            publicKey,
            pool.info.lpmint
          );

          return {
            ...pool,
            lpBalance,
            liquidityToRemove: '',
            estimatedTokenAReturn: '0',
            estimatedTokenBReturn: '0'
          };
        })
      );

      // Check LP token balances
      const poolsWithLiquidity = enrichedPools.filter(pool =>
        parseFloat(pool.lpBalance) > 0
      );

      if (poolsWithLiquidity.length === 0) {
        toast.error('No LP tokens found', {
          description: 'You do not have any active liquidity positions.'
        });
      }

      toast.success('Pools Retrieved', {
        description: 'Successfully loaded your liquidity pools.',
        className: 'toast-success'
      });
      setUserPools(enrichedPools);
    } catch (error) {
      console.error('Failed to fetch user pools', error);
      toast.error('Pool Retrieval Failed', {
        description: 'Unable to fetch your liquidity pools. Please try again.'
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Set Max Liquidity for a Specific Pool
  const setMaxLiquidity = (pool: UserPoolData) => {
    // const updatedPools = userPools.map(p =>
    //   p.pool === pool.pool
    //     ? {
    //       ...p,
    //       liquidityToRemove: p.lpBalance,
    //       ...calculateTokenReturns(p.lpBalance, p)
    //     }
    //     : p
    // );
    // setUserPools(updatedPools);
  };

  // Liquidity Removal Amount Handler
  const handleLiquidityRemoveChange = (
    pool: UserPoolData,
    value: string
  ) => {
    const numericValue = value.replace(/[^0-9.]/g, '');

    // Validate input is not greater than available balance
    // const sanitizedValue = Math.min(
    //   parseFloat(numericValue),
    //   parseFloat(pool.lpBalance)
    // ).toString();

    // const updatedPools = userPools.map(p =>
    //   p.pool === pool.pool
    //     ? {
    //       ...p,
    //       liquidityToRemove: sanitizedValue,
    //       ...calculateTokenReturns(sanitizedValue, p)
    //     }
    //     : p
    // );

    // setUserPools(updatedPools);
  };

  // Token Return Calculation
  const calculateTokenReturns = (
    lpAmount: string,
    pool: UserPoolData,
    poolReserveA: anchor.BN,
    poolReserveB: anchor.BN
  ) => {
    // Implement precise liquidity calculation logic
    // This is a simplified proportional calculation
    const lpAmountNum = parseFloat(lpAmount);
    const lpBalance = parseFloat(pool.lpBalance);

    return {
      // estimatedTokenAReturn: (lpAmountNum / lpBalance * poolReserveA).toString(),
      // estimatedTokenBReturn: (lpAmountNum / lpBalance * poolReserveB).toString()
    };
  };

  // Updated handler function
  const handleRemoveLiquidity = async (pool: UserPoolData) => {
    console.log("Handle Remove LIquidity");
    
    if (!pool.liquidityToRemove) return;

    try {
      const success = await removeLiquidity({
        connection,
        wallet: anchorWallet as anchor.Wallet, 
        liquidity: parseFloat(pool.liquidityToRemove),
        userPoolInfo: pool
      });

      if (success.success) {
        // Refresh user pools after successful removal
        await handleFetchUserPools();

        // toast.success('Liquidity removed successfully');
      }
    } catch (error) {
      console.error('Liquidity removal failed', error);

      // toast.error('Failed to remove liquidity. Please try again.');
    }
  };

  const getTokenSymbol = (mint: string, mints: MintData[]) => {
    const tokenInfo = mints.find(m => m.mint === mint)?.info;
    return tokenInfo?.symbol || 'Unknown';
  };

  const TokenIcon: React.FC<TokenIconProps> = ({ mint, mints, className }) => {
    const tokenInfo = mints.find(m => m.mint === mint)?.info;
    return tokenInfo?.image ? (
      <img
        src={tokenInfo.image}
        alt={tokenInfo.symbol}
        className={className}
      />
    ) : null;
  };


  // Effect to estimate swap amount when inputs change
  useEffect(() => {
    const estimateSwap = async () => {
      if (!connection || !selectedTokenFrom || !selectedTokenTo || !fromAmount) {
        setToAmount('');
        setSwapEstimation(null);
        return;
      }
      console.log("new slippage", slippage);

      try {
        const estimation = await estimateSwapAmount(
          connection,
          selectedTokenFrom.mint,
          selectedTokenTo.mint,
          fromAmount,
          slippage,
          anchorWallet as anchor.Wallet
        );

        setToAmount(estimation.estimatedOutput.toString());
        setSwapEstimation(estimation); // These are the amounts for display purposes.... 
      } catch (error) {
        console.error('Swap estimation error:', error);
        setToAmount('');
        setSwapEstimation(null);
      }
    };

    estimateSwap();
  }, [
    connection,
    selectedTokenFrom?.mint,
    selectedTokenTo?.mint,
    fromAmount,
    slippage
  ]);

  const handleFeeChange = (value: string) => {
    // Only allow numbers and up to 2 decimal places
    const regex = /^\d*\.?\d{0,2}$/;
    if (value === '' || regex.test(value)) {
      // Ensure fee is not greater than 100
      if (value === '' || parseFloat(value) <= 30) {
        // TODO YOU AREN'T HANDLING THIS PROPERLY. WHAT HAPPENS WHEN IT'S = ''
        setPoolFee(value);
      }
    }
  };

  // Handler for from amount input
  const handleFromAmountChange = (value: string) => {
    // Validate input (optional)
    const cleanedValue = value.replace(/[^0-9.]/g, '');
    setFromAmount(cleanedValue);
  };

  // Handler for to amount input
  const handleToAmountChange = (value: string) => {
    // Validate input (optional)
    const cleanedValue = value.replace(/[^0-9.]/g, '');
    setToAmount(cleanedValue);
  };

  // Handler for slippage change
  const handleSlippageChange = (value: string) => {
    console.log("I was triggered")
    const numValue = Number(value);
    setSlippage(
      isNaN(numValue) ? 0.5 :
        Math.min(Math.max(numValue, 0.1), 20)
    );
  };

  // Effect to fetch balances when tokens change or wallet connects
  useEffect(() => {
    const fetchBalances = async () => {
      if (!connection || !publicKey) {
        setFromTokenBalance(null);
        setToTokenBalance(null);
        return;
      }

      if (selectedTokenFrom) {
        const balance = await getTokenBalance(
          connection,
          publicKey,
          selectedTokenFrom.mint
        );
        setFromTokenBalance(balance);
      }

      if (selectedTokenTo) {
        const balance = await getTokenBalance(
          connection,
          publicKey,
          selectedTokenTo.mint
        );
        setToTokenBalance(balance);
      }

      // Add Liquidity token balances
      if (tokenAMint) {
        const balance = await getTokenBalance(
          connection,
          publicKey,
          tokenAMint.mint
        );
        setTokenABalance(balance);
      }

      if (tokenBMint) {
        const balance = await getTokenBalance(
          connection,
          publicKey,
          tokenBMint.mint
        );
        setTokenBBalance(balance);
      }
    };

    fetchBalances();
  }, [
    connection,
    publicKey,
    selectedTokenFrom?.mint,
    selectedTokenTo?.mint,
    tokenAMint?.mint,
    tokenBMint?.mint
  ]);

  // Handlers for Add Liquidity token selection
  const handleOpenAddLiquidityModal = (type: 'from' | 'to') => {
    setModalType(type);
    setIsModalOpen(true);
  };

  const handleAddLiquidityTokenSelect = (mint: string, tokenInfo: TokenInfo) => {
    if (modalType === 'from') {
      setTokenAMint({ mint, info: tokenInfo });
      // If no TokenB is selected, default to SOL
      if (!tokenBMint) {
        setTokenBMint(SOL_TOKEN_INFO);
      }
    } else {
      setTokenBMint({ mint, info: tokenInfo });
      // If no TokenA is selected, default to a token from the list
      if (!tokenAMint) {
        setTokenAMint(SOL_TOKEN_INFO);
      }
    }
    setIsModalOpen(false);
  };

  // Add Liquidity button handler
  const handleAddLiquidity = async () => {
    // console.log(publicKey, tokenAMint, tokenBMint, connection);

    if (!publicKey || !connection || !tokenAMint || !tokenBMint) {
      console.error('Cannot add liquidity: Wallet not connected or tokens not selected');
      return;
    }

    try {
      // if (tokenAMint.info.poolAddress === tokenBMint.info.poolAddress) {
      // TODO HANDLE SAME TOKEN LP RETURN WITH ERROR MESSAGE
      //   return;
      // }

      // console.log('Adding Liquidity:', {
      //   tokenA: tokenAMint.info.symbol,
      //   tokenB: tokenBMint.info.symbol,
      //   amountA: tokenAAmount,
      //   amountB: tokenBAmount,
      //   isNewPool: isNewPool,
      //   user: anchorWallet?.publicKey
      // });

      if (isNewPool) {
        const tx = await addLiquidityNew({
          connection,
          wallet: anchorWallet as anchor.Wallet,
          // signTransaction: signTransaction!,
          // publicKey: publicKey!,
          tokenAMint: new PublicKey(tokenAMint.mint),
          tokenBMint: new PublicKey(tokenBMint.mint),
          amountA: Number(tokenAAmount),
          amountB: Number(tokenBAmount),
          isNewPool: isNewPool,
          fee: poolFee
        });
        console.log('Created new pool...');

        // Reset form or show success message
        setTokenAAmount('');
        setTokenBAmount('');
        setIsNewPool(false);
        setPoolFee('0');

        return;
      }
      // else add liquidity to other existing pools

      // Show loading state
      // You might want to add a loading state to your UI

      const tx = await addLiquidity({
        connection,
        wallet: anchorWallet as anchor.Wallet,
        tokenAMint: new PublicKey(tokenAMint.mint),
        tokenBMint: new PublicKey(tokenBMint.mint),
        amountA: Number(tokenAAmount),
        amountB: Number(tokenBAmount),
        isNewPool: isNewPool,
        fee: poolFee
      });

      // console.log('Liquidity added successfully:', tx);

      // Reset form or show success message
      setTokenAAmount('');
      setTokenBAmount('');
      setIsNewPool(false);
      setPoolFee('0');

      console.log("Added Liquidity To Pool");

      // Optionally refresh balances
      // You might want to add a function to refresh token balances

    } catch (error) {
      console.error('Add Liquidity Error:', error);
    }
  };

  // Handler for token amount inputs
  const handleTokenAAmountChange = (value: string) => {
    const cleanedValue = value.replace(/[^0-9.]/g, '');
    setTokenAAmount(cleanedValue);
  };

  const handleTokenBAmountChange = (value: string) => {
    const cleanedValue = value.replace(/[^0-9.]/g, '');
    setTokenBAmount(cleanedValue);
  };


  const handleOpenModal = (type: 'from' | 'to') => {
    setModalType(type);
    setIsModalOpen(true);
  };

  const handleTokenSelect = (mint: string, tokenInfo: TokenInfo) => {
    if (modalType === 'from') {
      setSelectedTokenFrom({ mint, info: tokenInfo });
      // If "to" token is not set, set it to SOL
      if (!selectedTokenTo) {
        setSelectedTokenTo(SOL_TOKEN_INFO);
      }
    } else {
      setSelectedTokenTo({ mint, info: tokenInfo });
      // If "from" token is not set, set it to SOL
      if (!selectedTokenFrom) {
        setSelectedTokenFrom(SOL_TOKEN_INFO);
      }
    }
    setIsModalOpen(false);
  };

  const handleSwap = async () => {
    console.log(publicKey, selectedTokenTo, selectedTokenFrom);

    if (!publicKey || !connection || !selectedTokenFrom || !selectedTokenTo) {
      console.error('Cannot swap tokens: Wallet not connected or tokens not selected');
      return;
    }

    try {

      const tx = await Swap({
        connection,
        fromToken: new PublicKey(selectedTokenFrom.mint),
        toToken: new PublicKey(selectedTokenTo.mint),
        fromAmount: Number(fromAmount),
        // toAmount: Number(tokenBAmount),
        slippage,
        wallet: anchorWallet as anchor.Wallet
      });

      // WHAT ARE WE RESETTING AGAIN? 
      setTokenAAmount('');
      setTokenBAmount('');
      setToAmount("");
      setFromAmount("");

      // TODO CREATE A FUNCTION THAT REFRESES BALANCES
      return tx;

    } catch (error) {
      console.error('Swap failed:', error);
      throw error;
    }
  };

  return (
    <div className="min-h-screen bg-[#0D0A0E] text-white pt-5">
      {/* Header Section */}
      <div className="flex justify-between items-center px-8 py-4 relative">
        <div className="flex items-center">
          <img
            src="/baby-logo.png"
            alt="Baby Swap Logo"
            className="w-10 h-10 mr-2"
          />
          <h1 className="text-pink-300 text-2xl font-bold">Baby Swap</h1>
        </div>

        <div className="absolute left-1/2 transform -translate-x-1/2 w-1/3">
          <div className="flex items-center space-x-2 bg-[#201822] text-white px-4 py-2 rounded-md focus-within:ring-2 focus-within:ring-pink-300">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5 text-pink-200"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-4.35-4.35m1.39-5.39a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              type="text"
              placeholder="Search Tokens"
              className="bg-transparent flex-grow text-white placeholder-white-400 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex items-center space-x-6">
          <a href="/pool" className="text-pink-300 hover:text-white transition">
            Pool
          </a>
          <a href="/stake" className="text-pink-300 hover:text-white transition">
            Stake
          </a>
          <WalletMultiButtonDynamic>
            {publicKey
              ? `${publicKey.toBase58().substring(0, 5)}...`
              : "Connect Wallet"}
          </WalletMultiButtonDynamic>
        </div>
      </div>

      {/* Main Page */}
      <main className="flex justify-center items-center min-h-[90vh]">
        <div className="w-full max-w-md space-y-6 px-4 py-8 rounded-lg shadow-lg">
          <div className="flex justify-between space-x-2">
            <button
              onClick={() => setActiveTab("swap")}
              className={`w-1/3 py-2 rounded-md ${activeTab === "swap" ? "bg-pink-300 text-black" : "bg-gray-700"
                }`}
            >
              Swap
            </button>
            <button
              onClick={() => setActiveTab("addLiquidity")}
              className={`w-1/3 py-2 rounded-md ${activeTab === "addLiquidity" ? "bg-pink-300 text-black" : "bg-gray-700"
                }`}
            >
              Add Liquidity
            </button>
            <button
              onClick={() => setActiveTab("removeLiquidity")}
              className={`w-1/3 py-2 rounded-md ${activeTab === "removeLiquidity" ? "bg-pink-300 text-black" : "bg-gray-700"
                }`}
            >
              Remove Liquidity
            </button>
          </div>

          {/* swap section */}
          {activeTab === "swap" && (
            <div className="space-y-4">

              {/* From Section */}
              <div className="border border-gray-600 rounded-md p-6">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="text-gray-400">From</h3>
                  {publicKey && (
                    <span className="text-sm text-gray-400">
                      Balance: {formatBalance(fromTokenBalance)}
                    </span>
                  )}
                </div>
                <div className="flex items-center">
                  <input
                    type="number"
                    placeholder="0"
                    value={fromAmount}
                    onChange={(e) => handleFromAmountChange(e.target.value)}
                    className="bg-transparent text-white flex-grow placeholder-gray-500 focus:outline-none"
                  />
                  <button
                    className="ml-2 px-3 py-1 bg-pink-300 text-black rounded-md flex items-center"
                    onClick={() => handleOpenModal('from')}
                  >
                    {selectedTokenFrom ? (
                      <>
                        {selectedTokenFrom.info.image && (
                          <img
                            src={selectedTokenFrom.info.image}
                            alt={selectedTokenFrom.info.symbol}
                            className="w-4 h-4 rounded-full mr-1"
                          />
                        )}
                        {selectedTokenFrom.info.symbol}
                      </>
                    ) : (
                      "Select Token"
                    )}
                  </button>
                </div>
              </div>

              {/* To Section */}
              <div className="border border-gray-600 rounded-md p-6">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="text-gray-400">To</h3>
                  {publicKey && (
                    <span className="text-sm text-gray-400">
                      Balance: {formatBalance(toTokenBalance)}
                    </span>
                  )}
                </div>
                <div className="flex items-center">
                  <input
                    type="number"
                    placeholder="0"
                    value={toAmount}
                    // onChange={(e) => handleToAmountChange(e.target.value)}
                    readOnly
                    className="bg-transparent text-white flex-grow placeholder-gray-500 focus:outline-none"
                  />
                  <button
                    className="ml-2 px-3 py-1 bg-pink-300 text-black rounded-md flex items-center"
                    onClick={() => handleOpenModal('to')}
                  >
                    {selectedTokenTo ? (
                      <>
                        {selectedTokenTo.info.image && (
                          <img
                            src={selectedTokenTo.info.image}
                            alt={selectedTokenTo.info.symbol}
                            className="w-4 h-4 rounded-full mr-1"
                          />
                        )}
                        {selectedTokenTo.info.symbol}
                      </>
                    ) : (
                      "Select Token"
                    )}
                  </button>
                </div>
              </div>

              {/* Slippage Section */}
              <div className="border border-gray-600 rounded-md p-4 space-y-2">
                <div className="flex justify-between items-center">
                  <label htmlFor="slippage" className="text-gray-400">Slippage Tolerance (%)</label>
                  <input
                    type="number"
                    id="slippage"
                    value={slippage}
                    onChange={(e) => handleSlippageChange(e.target.value)}
                    className="w-16 bg-transparent text-white text-right placeholder-gray-500 focus:outline-none border-b border-gray-400"
                  />
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={20}
                  step={0.1}
                  value={slippage}
                  onChange={(e) => handleSlippageChange(e.target.value)}
                  className="w-full"
                />
                <div className="flex justify-between text-gray-400 text-sm">
                  <span>0.1%</span>
                  <span>20%</span>
                </div>
              </div>

              {/* Swap Button */}
              <button
                onClick={handleSwap}
                className={`w-full py-3 bg-pink-300 text-black rounded-md ${!publicKey || !fromAmount || !selectedTokenTo?.mint ? 'opacity-50 cursor-not-allowed' : ''} `}
                disabled={!publicKey || !fromAmount}
              >
                {publicKey ? "Swap" : "Wallet Not Connected"}
              </button>
            </div>
          )}

          {/* Add Liquidity Interface */}
          {activeTab === "addLiquidity" && (
            <div className="space-y-4">
              {/* New Pool Toggle Button */}
              <div className="flex justify-between items-center mb-4">
                <button
                  onClick={() => {
                    setIsNewPool(!isNewPool);
                    if (!isNewPool) setPoolFee('0'); // Reset fee when enabling new pool
                  }}
                  className={`px-4 py-2 rounded-full transition-all duration-300 flex items-center gap-2
            ${isNewPool
                      ? 'bg-gradient-to-r from-pink-500 to-purple-500 text-white shadow-lg transform scale-105'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                >
                  <span>{isNewPool ? 'New Pool' : 'Create New Pool'}</span>
                  {isNewPool && (
                    <span className="bg-white text-pink-500 text-xs px-2 py-1 rounded-full">
                      Active
                    </span>
                  )}
                </button>
              </div>

              {/* Fee Input - Only shown when creating new pool */}
              {isNewPool && (
                <div className="border border-pink-500 rounded-md p-6 bg-gray-800/50 shadow-pink-500/20 shadow-lg">
                  <div className="flex justify-between items-center mb-2">
                    <h3 className="text-gray-400">Pool Fee (%)</h3>
                    <span className="text-xs text-gray-400">Range: 0-100%</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <input
                      type="text"
                      placeholder="0"
                      value={poolFee}
                      onChange={(e) => handleFeeChange(e.target.value)}
                      className="bg-transparent text-white flex-grow placeholder-gray-500 focus:outline-none border-b border-pink-500/30 focus:border-pink-500 transition-colors px-2 py-1"
                    />
                    <span className="text-gray-400">%</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    Set the fee percentage for this pool. This fee will be applied to all swaps.
                  </p>
                </div>
              )}

              {/* Token A Section */}
              <div className={`border rounded-md p-6 transition-all duration-300 ${isNewPool ? 'border-pink-500 shadow-pink-500/20 shadow-lg' : 'border-gray-600'
                }`}>
                <div className="flex justify-between items-center mb-2">
                  <h3 className="text-gray-400">Token A</h3>
                  {publicKey && (
                    <span className="text-sm text-gray-400">
                      Balance: {formatBalance(tokenABalance)}
                    </span>
                  )}
                </div>
                <div className="flex items-center">
                  <input
                    type="text"
                    placeholder="0"
                    value={tokenAAmount}
                    onChange={(e) => handleTokenAAmountChange(e.target.value)}
                    className="bg-transparent text-white flex-grow placeholder-gray-500 focus:outline-none"
                  />
                  <button
                    className="ml-2 px-3 py-1 bg-pink-300 text-black rounded-md flex items-center"
                    onClick={() => handleOpenAddLiquidityModal('from')}
                  >
                    {tokenAMint ? (
                      <>
                        {tokenAMint.info.image && (
                          <img
                            src={tokenAMint.info.image}
                            alt={tokenAMint.info.symbol}
                            className="w-4 h-4 rounded-full mr-1"
                          />
                        )}
                        {tokenAMint.info.symbol}
                      </>
                    ) : (
                      "Select Token A"
                    )}
                  </button>
                </div>
              </div>

              {/* Token B Section */}
              <div className={`border rounded-md p-6 transition-all duration-300 ${isNewPool ? 'border-pink-500 shadow-pink-500/20 shadow-lg' : 'border-gray-600'
                }`}>
                <div className="flex justify-between items-center mb-2">
                  <h3 className="text-gray-400">Token B</h3>
                  {publicKey && (
                    <span className="text-sm text-gray-400">
                      Balance: {formatBalance(tokenBBalance)}
                    </span>
                  )}
                </div>
                <div className="flex items-center">
                  <input
                    type="text"
                    placeholder="0"
                    value={tokenBAmount}
                    onChange={(e) => handleTokenBAmountChange(e.target.value)}
                    className="bg-transparent text-white flex-grow placeholder-gray-500 focus:outline-none"
                  />
                  <button
                    className="ml-2 px-3 py-1 bg-pink-300 text-black rounded-md flex items-center"
                    onClick={() => handleOpenAddLiquidityModal('to')}
                  >
                    {tokenBMint ? (
                      <>
                        {tokenBMint.info.image && (
                          <img
                            src={tokenBMint.info.image}
                            alt={tokenBMint.info.symbol}
                            className="w-4 h-4 rounded-full mr-1"
                          />
                        )}
                        {tokenBMint.info.symbol}
                      </>
                    ) : (
                      "Select Token B (SOL)"
                    )}
                  </button>
                </div>
              </div>

              {/* Add Liquidity Button */}
              <button
                onClick={handleAddLiquidity}
                className={`w-full py-3 rounded-md transition-all duration-300 ${isNewPool
                  ? 'bg-gradient-to-r from-pink-500 to-purple-500 text-white shadow-lg'
                  : 'bg-pink-300 text-black'
                  } ${(!publicKey || !tokenAAmount || !tokenBAmount) ? 'opacity-50 cursor-not-allowed' : ''}`}
                disabled={!publicKey || !tokenAAmount || !tokenBAmount}
              >
                {!publicKey
                  ? "Wallet Not Connected"
                  : (!tokenAAmount || !tokenBAmount)
                    ? "Enter Amounts"
                    : isNewPool
                      ? "Create New Pool"
                      : "Add Liquidity"}
              </button>
            </div>
          )}

          {/* RemoveLiquidity Interface */}
          {activeTab === "removeLiquidity" && (
            <div className="space-y-4">
              {/* Fetch Pools Button */}
              <button
                onClick={handleFetchUserPools}
                disabled={!publicKey || isLoading}
                className={`w-full px-4 py-2 rounded-full transition-all duration-300 flex items-center justify-center gap-2 ${!publicKey
                    ? 'bg-gray-700 text-gray-300 opacity-50 cursor-not-allowed'
                    : isLoading
                      ? 'bg-gradient-to-r from-pink-500 to-purple-500 text-white'
                      : 'bg-gradient-to-r from-pink-500 to-purple-500 text-white hover:opacity-90'
                  }`}
              >
                {isLoading ? (
                  <div className="flex items-center">
                    <svg
                      className="animate-spin h-5 w-5 mr-2"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    Fetching Pools...
                  </div>
                ) : (
                  "Find My Liquidity Pools"
                )}
              </button>

              {/* User Pools Display */}
              {!isLoading && userPools.length === 0 && publicKey && (
                <div className="text-center bg-gray-700 p-6 rounded-md">
                  <p className="text-gray-400">
                    No liquidity pools found for your wallet.
                  </p>
                </div>
              )}

              {/* Pools Listing */}
              {!isLoading && userPools.length > 0 && (
                <div className="space-y-4">
                  {userPools.map((poolData) => (
                    <div
                      key={poolData.pool}
                      className="border border-pink-500 rounded-md p-6 bg-gray-800/50 shadow-pink-500/20 shadow-lg"
                    >
                      <div className="flex justify-between items-center mb-4">
                        <h3 className="text-gray-400">{poolData.info.symbol}</h3>
                        <span className="text-sm text-gray-400">
                          TVL: ${formatBalance(poolData.info.tvl)} | Fee: {poolData.info.fee}%
                        </span>
                      </div>

                      <div className="flex justify-between items-center mb-4">
                        <div className="flex items-center gap-2">
                          <TokenIcon
                            mint={poolData.info.tokena}
                            mints={mints}
                            className="w-6 h-6 rounded-full"
                          />
                          <TokenIcon
                            mint={poolData.info.tokenb}
                            mints={mints}
                            className="w-6 h-6 rounded-full -ml-2"
                          />
                          <span className="text-white ml-2">
                            {getTokenSymbol(poolData.info.tokena, mints)}/{getTokenSymbol(poolData.info.tokenb, mints)}
                          </span>
                        </div>
                        <span className="text-sm text-gray-400">
                          LP Balance: {formatBalance(Number(poolData.lpBalance))}
                        </span>
                      </div>

                      {/* Liquidity Removal Input */}
                      <div className="flex items-center space-x-4 mb-4">
                        <div className="flex-grow">
                          <input
                            type="text"
                            placeholder="Enter LP Tokens to Remove"
                            value={poolData.liquidityToRemove}
                            onChange={(e) => handleLiquidityRemoveChange(poolData, e.target.value)}
                            className="bg-transparent text-white w-full placeholder-gray-500 focus:outline-none border-b border-pink-500/30 focus:border-pink-500 transition-colors px-2 py-1"
                          />
                        </div>
                        <button
                          onClick={() => setMaxLiquidity(poolData)}
                          className="text-xs bg-pink-300 text-black px-3 py-1 rounded-md"
                        >
                          Max
                        </button>
                      </div>

                      {/* Estimated Returns */}
                      <div className="bg-gray-700 rounded-md p-4">
                        <div className="flex justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <TokenIcon
                              mint={poolData.info.tokena}
                              mints={mints}
                              className="w-5 h-5 rounded-full"
                            />
                            <span className="text-gray-400">
                              {getTokenSymbol(poolData.info.tokena, mints)}
                            </span>
                          </div>
                          <span className="text-white">
                            {formatBalance(Number(poolData.estimatedTokenAReturn))}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <div className="flex items-center gap-2">
                            <TokenIcon
                              mint={poolData.info.tokenb}
                              mints={mints}
                              className="w-5 h-5 rounded-full"
                            />
                            <span className="text-gray-400">
                              {getTokenSymbol(poolData.info.tokenb, mints)}
                            </span>
                          </div>
                          <span className="text-white">
                            {formatBalance(Number(poolData.estimatedTokenBReturn))}
                          </span>
                        </div>
                      </div>

                      {/* Remove Liquidity Button */}
                      <button
                        onClick={() => handleRemoveLiquidity(poolData)}
                        className={`w-full mt-4 py-3 rounded-md transition-all duration-300 ${poolData.liquidityToRemove
                            ? 'bg-gradient-to-r from-pink-500 to-purple-500 text-white shadow-lg'
                            : 'bg-gray-700 text-gray-300 opacity-50 cursor-not-allowed'
                          }`}
                        disabled={!poolData.liquidityToRemove}
                      >
                        Remove Liquidity
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <TokenModal
            isOpen={isModalOpen}
            onClose={() => setIsModalOpen(false)}
            onTokenSelect={activeTab === 'addLiquidity' ? handleAddLiquidityTokenSelect : handleTokenSelect}
            tokens={mints}
          />
        </div>
      </main>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async () => {
  try {
    // console.log('=================😃 connected to db 😃=================');
    const client = await pool.connect();
    const [contracts, poolAdd] = await Promise.all([
      client.query('SELECT * FROM contracts'),
      client.query('SELECT * FROM pools')
    ]);

    // console.log('=================😃 Fetched Data from db 😃=================');
    client.release();
    return {
      props: {
        mints: contracts.rows.map(row => serializeData(row)),
        pools: poolAdd.rows.map(row => serializeData(row))
      },
    };

  } catch (error) {
    console.error('Failed to fetch data:', error);
    return {
      props: {
        mints: [],
        pools: [],
      }
    };
  }
}

function serializeData(obj: any): any {
  return Object.entries(obj).reduce((acc, [key, value]) => {
    // Handle null values
    if (value === null) {
      acc[key] = null;
      return acc;
    }

    // Handle Date objects
    if (value instanceof Date) {
      acc[key] = value.toISOString();
      return acc;
    }

    // Handle nested objects (including JSONB from PostgreSQL)
    if (typeof value === 'object') {
      acc[key] = serializeData(value);
      return acc;
    }

    acc[key] = value;
    return acc;
  }, {} as any);
}