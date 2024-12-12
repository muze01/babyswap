import React, { useState, useEffect, useMemo } from "react";
import { SOL_TOKEN_INFO } from "@/pages";

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

interface MintData {
    mint: string;
    info: TokenInfo;
}

interface TokenModalProps {
    isOpen: boolean;
    onClose: () => void;
    onTokenSelect: (token: string, tokenInfo: TokenInfo) => void;
    tokens: MintData[];
}

const TokenModal: React.FC<TokenModalProps> = ({ isOpen, onClose, onTokenSelect, tokens }) => {
    const [searchTerm, setSearchTerm] = useState<string>("");

    const allTokens = useMemo(() => {
        const existingSol = tokens.find(t => t.mint === SOL_TOKEN_INFO.mint);
        if (!existingSol) {
            return [SOL_TOKEN_INFO, ...tokens];
        }
        return tokens;
    }, [tokens]);

    const filteredTokens = allTokens.filter(token =>
        token.mint.toLowerCase().includes(searchTerm.toLowerCase()) ||
        token.info.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        token.info.symbol.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return isOpen ? (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
            <div className="bg-gray-800 rounded-lg w-96 p-6">
                <h2 className="text-lg font-bold text-white mb-4">Select Token</h2>
                <input
                    type="text"
                    placeholder="Search by name, symbol, or address"
                    className="w-full p-2 mb-4 rounded bg-gray-700 text-white"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                />
                <div className="max-h-60 overflow-y-auto">
                    {filteredTokens.length > 0 ? (
                        filteredTokens.map((token) => (
                            <button
                                key={token.mint}
                                className="block w-full text-left p-2 mb-2 rounded bg-gray-700 text-white hover:bg-pink-300 hover:text-black"
                                onClick={() => onTokenSelect(token.mint, token.info)}
                            >
                                <div className="flex items-center">
                                    {token.info.image && (
                                        <img
                                            src={token.info.image}
                                            alt={token.info.symbol}
                                            className="w-6 h-6 rounded-full mr-2"
                                        />
                                    )}
                                    <div>
                                        <div className="font-medium">{token.info.symbol}</div>
                                        <div className="text-sm text-gray-400">{token.info.name}</div>
                                    </div>
                                </div>
                            </button>
                        ))
                    ) : (
                        <p className="text-gray-400">No tokens found</p>
                    )}
                </div>
                <button
                    className="mt-4 w-full py-2 bg-red-600 text-white rounded-md"
                    onClick={onClose}
                >
                    Close
                </button>
            </div>
        </div>
    ) : null;
};

export default TokenModal;
