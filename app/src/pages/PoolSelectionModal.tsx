import { formatBalance } from "@/utils/swap";
import { MintData, PoolData } from ".";
import React from "react";
import Modal from "./Modal";

export interface PoolSelectionModalProps {
    isOpen: boolean;        
    onClose: () => void;    
    pools: PoolData[];      
    mints: MintData[];      
    onPoolSelect: (pool: PoolData) => void; 
}

export interface TokenIconProps {
    mint: string;  
    mints: MintData[];  
    className?: string;  
}

// Pool Selection Modal Component
const PoolSelectionModal: React.FC<PoolSelectionModalProps> = ({
    isOpen,
    onClose,
    pools,
    mints,
    onPoolSelect
}) => {
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            className="max-w-md w-full"
        >
            <div className="p-6">
                <h2 className="text-xl font-bold mb-4 text-white">Select Liquidity Pool</h2>

                {pools.length === 0 ? (
                    <p className="text-center text-gray-400">No pools available</p>
                ) : (
                    <div className="space-y-3">
                        {pools.map((poolData) => (
                            <button
                                key={poolData.pool}
                                onClick={() => {
                                    onPoolSelect(poolData);
                                    onClose();
                                }}
                                className="w-full flex items-center justify-between p-4 bg-gray-700 rounded-md hover:bg-gray-600 transition-colors"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="flex">
                                        <TokenIcon
                                            mint={poolData.info.tokena}
                                            mints={mints}
                                            className="w-6 h-6 rounded-full -mr-2 z-10"
                                        />
                                        <TokenIcon
                                            mint={poolData.info.tokenb}
                                            mints={mints}
                                            className="w-6 h-6 rounded-full"
                                        />
                                    </div>
                                    <div className="text-left">
                                        <p className="font-semibold text-white">
                                            {poolData.info.symbol}
                                        </p>
                                        <p className="text-xs text-gray-400">
                                            TVL: ${formatBalance(poolData.info.tvl)} | Fee: {poolData.info.fee}%
                                        </p>
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </Modal>
    );
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

export default PoolSelectionModal;