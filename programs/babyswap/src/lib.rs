use anchor_lang::{
    prelude::*, solana_program::program::*,
    solana_program::program_pack::Pack, 
    // solana_program::pubkey,
};
use anchor_spl::{
    associated_token::*,
    token::{mint_to, Mint, MintTo, Token, TokenAccount, Transfer, burn, Burn, close_account, CloseAccount},
    token::transfer
};
use spl_token::state::Account as AccountState;

declare_id!("4hfWrBXXKKYuQ91bjfAiccq3WTJjWkuYjiwuHK8Xmmmr");
// const ADMIN_PUBKEY: Pubkey = pubkey!("nktzW8vT4Fzaegd2qqgf24ZPLf11yDVdfEvfbkB4FQz");

#[program]
mod babyswap {
    use super::*;

    // #[inline(never)]
    pub fn initialize_pool(ctx: Context<InitializePool>, fee: u64) -> Result<()> {
        
        // Fee Should Be 3% Max
        if fee.gt(&300) {
            return Err(ErrorCode::FeeTooHigh.into());
        }

        let mint_a = ctx.accounts.mint_a.key();
        let mint_b = ctx.accounts.mint_b.key();

        // Ensure pool uniqueness
        let (pool_pda_1, _) = Pubkey::find_program_address(
            &[
            b"pool", 
            // mint_a.as_ref(), 
            mint_b.as_ref()
            ], 
            ctx.program_id
        );

        // Ensure the pool address passed matches the correct order
        let expected_pool_pda = ctx.accounts.pool.key(); 
        if expected_pool_pda != pool_pda_1 {
            return Err(ErrorCode::InvalidTokenOrder.into());
        }

        let pool = &mut ctx.accounts.pool;
        pool.pool = expected_pool_pda;
        pool.mint_a = mint_a;
        pool.mint_b = mint_b;
        pool.fees = fee;
        pool.total_liquidity = 0;

        msg!("Pool Initialized mint_a: {:?}, mint_b: {:?}, fee: {}, pool address: {:?}", 
        mint_a, mint_b, fee, expected_pool_pda);

        Ok(())
    }

    // #[inline(never)]
    pub fn buy(ctx: Context<BuyInstruction>, swap: BuyInstructionData) -> Result<()> {
        msg!("WASH P HOW FAR, NA POXXIE");

        // Validate slippage
        let slippage = swap.slippage;
        const MAX_SLIPPAGE_BPS: u64 = 10000;  // 100%
        const MIN_SLIPPAGE_BPS: u64 = 10;     // 0.1%      
        if slippage.gt(&MAX_SLIPPAGE_BPS) || slippage.lt(&MIN_SLIPPAGE_BPS) {
            return Err(ErrorCode::InvalidSlippageValue.into());
        }

        let amount = swap.amount as u128;
        if amount == 0 {
            return Err(ErrorCode::InvalidSwapAmount.into());
        }
        
        // Verify user's token B balance
        let user_token_data = AccountState::unpack(
            &ctx.accounts.user_token_a_ata.to_account_info().data.borrow()
        )?;
        if amount > user_token_data.amount as u128 {
            msg!(
                "Insufficient balance. Required: {} tokens, Available: {} tokens", 
                swap.amount,
                user_token_data.amount
            );
            return Err(ErrorCode::InsufficientTokenBBalance.into());
        }

        let pool = &mut ctx.accounts.pool;
        let _mint_a = pool.mint_a;
        let mint_b = pool.mint_b;

        // Input and output reserves for buy operation
        let output_reserve = ctx.accounts.pool_token_b_ata.amount as u128;
        let input_reserve = ctx.accounts.pool_token_a_ata.amount as u128;

        // Calculate fee for buy operation
        let fee_amount = amount
            .checked_mul(pool.fees as u128)  
            .and_then(|v| v.checked_div(10000))
            .ok_or(ErrorCode::IntegerOverflowFeeAmount)?;
        
        let net_input = amount
            .checked_sub(fee_amount)
            .ok_or(ErrorCode::IntegerOverflowNetInput)?;

        // Update reserves and calculate output
        let new_input_reserve = input_reserve
            .checked_add(net_input)
            .ok_or(ErrorCode::IntegerOverflowNewInputReserve)?;

        let constant_product = input_reserve
            .checked_mul(output_reserve)
            .ok_or(ErrorCode::IntegerOverflowK)?;

        let new_output_reserve = constant_product
            .checked_div(new_input_reserve)
            .ok_or(ErrorCode::IntegerOverflowNewOutputReserve)?;

        let gross_output_amount = output_reserve
            .checked_sub(new_output_reserve)
            .ok_or(ErrorCode::InsufficientLiquidity)?;

        // Validate slippage
        let slippage_value = gross_output_amount
            .checked_mul(slippage as u128)
            .and_then(|v| v.checked_div(10000))
            .ok_or(ErrorCode::IntegerOverflowSlippageValue)?;

        let min_output_amount = gross_output_amount
            .checked_sub(slippage_value)
            .ok_or(ErrorCode::IntegerOverflowMinOutputAmount)?;

        // Check that the user is receiving at least `min_output_amount`
        if gross_output_amount.lt(&min_output_amount) {
            return Err(ErrorCode::InsufficientOutputAmount.into());
        }

        // Prepare signer seeds
        let seeds: &[&[u8]] = &[
            b"pool",
            // mint_a.as_ref(),
            mint_b.as_ref(),
            &[ctx.bumps.pool],
        ];
        let signer = &[seeds];

        // Transfer Token A from user to pool
        let transfer_to_pool = spl_token::instruction::transfer(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.user_token_a_ata.key(), 
            &ctx.accounts.pool_token_a_ata.key(),
            &ctx.accounts.user.key(),
            &[],
            amount as u64
        )?;

        invoke_signed(
            &transfer_to_pool,
            &[
                ctx.accounts.token_program.to_account_info().clone(),
                ctx.accounts.user_token_a_ata.to_account_info().clone(),
                ctx.accounts.pool_token_a_ata.to_account_info().clone(),
                ctx.accounts.user.to_account_info().clone(),
            ],
            signer
        )?;

        // Transfer Token B from pool to user
        let transfer_tokens = spl_token::instruction::transfer(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.pool_token_b_ata.key(),
            &ctx.accounts.user_token_b_ata.key(),
            &ctx.accounts.pool.key(),
            &[],
            gross_output_amount as u64,
        )?;
        
        invoke_signed(
            &transfer_tokens,
            &[
                ctx.accounts.token_program.to_account_info().clone(),
                ctx.accounts.pool_token_b_ata.to_account_info().clone(),
                ctx.accounts.user_token_b_ata.to_account_info().clone(),
                ctx.accounts.pool.to_account_info().clone(),
            ],
            signer,
        )?;

        // Constant product invariant check
        let simulated_input_reserve = input_reserve
            .checked_add(net_input) 
            .ok_or(ErrorCode::IntegerOverflow11)?;

        let simulated_output_reserve = output_reserve
            .checked_sub(gross_output_amount) 
            .ok_or(ErrorCode::IntegerOverflow11)?;

        let k_initial = input_reserve
            .checked_mul(output_reserve)
            .ok_or(ErrorCode::IntegerOverflow11)?;

        let k_final = simulated_input_reserve
            .checked_mul(simulated_output_reserve)
            .ok_or(ErrorCode::IntegerOverflow12)?;

        let difference = k_initial.saturating_sub(k_final);

        const MAX_DEVIATION_BPS: u128 = 1; // 0.001% || 0.1 BPS
        let max_allowed_difference = k_initial
            .checked_mul(MAX_DEVIATION_BPS)
            .and_then(|v| v.checked_div(100000))
            .ok_or(ErrorCode::IntegerOverflow12)?;

        if difference > max_allowed_difference {
            msg!(
                "Constant product violated beyond tolerance: k_initial={}, k_final={}, difference={}, max_allowed={}",
                k_initial,
                k_final,
                difference,
                max_allowed_difference
            );
            return Err(ErrorCode::ConstantProductInvariantViolated.into());
        }

        msg!(
            "User bought {} tokens for {} tokens with slippage tolerance {:.2}%",
            gross_output_amount as u64, 
            swap.amount,
            slippage as f64 / 100.0
        );

        Ok(())
    }
    
    pub fn sell(ctx: Context<SellInstruction>, swap: SellInstructionData) -> Result<()> {
        msg!("WASH P HOW FAR, NA STILL POXXIE");

        // Validate slippage
        let slippage = swap.slippage;
        const MAX_SLIPPAGE_BPS: u64 = 10000;  // 100%
        const MIN_SLIPPAGE_BPS: u64 = 10;     // 0.1%      
        if slippage.gt(&MAX_SLIPPAGE_BPS) || slippage.lt(&MIN_SLIPPAGE_BPS) {
            return Err(ErrorCode::InvalidSlippageValue.into());
        }

        let amount = swap.amount as u128;
        if amount == 0 {
            return Err(ErrorCode::InvalidSwapAmount.into());
        }
        
        // Verify user's token A balance
        let user_token_data = AccountState::unpack(
            &ctx.accounts.user_token_a_ata.to_account_info().data.borrow()
        )?;
        if amount > user_token_data.amount as u128 {
            msg!(
                "Insufficient balance. Required: {} tokens, Available: {} tokens", 
                swap.amount,
                user_token_data.amount
            );
            return Err(ErrorCode::InsufficientTokenABalance.into());
        }

        let pool = &mut ctx.accounts.pool;
        // let mint_a = pool.mint_a;
        let mint_b = pool.mint_b;

        // Input and output reserves for sell operation
        let input_reserve = ctx.accounts.pool_token_a_ata.amount as u128;
        let output_reserve = ctx.accounts.pool_token_b_ata.amount as u128;

        // No fee deduction during input for sell operation
        let net_input = amount;

        // Update reserves and calculate output
        let new_input_reserve = input_reserve
            .checked_add(net_input)
            .ok_or(ErrorCode::IntegerOverflowNewInputReserve)?;

        let constant_product = input_reserve
            .checked_mul(output_reserve)
            .ok_or(ErrorCode::IntegerOverflowK)?;

        let new_output_reserve = constant_product
            .checked_div(new_input_reserve)
            .ok_or(ErrorCode::IntegerOverflowNewOutputReserve)?;

        let gross_output_amount = output_reserve
            .checked_sub(new_output_reserve)
            .ok_or(ErrorCode::InsufficientLiquidity)?;

        // Calculate fee for sell operation
        let fee_amount = gross_output_amount
            .checked_mul(pool.fees as u128)
            .and_then(|v| v.checked_div(10000))
            .ok_or(ErrorCode::IntegerOverflowFeeAmount)?;

        let net_output_amount = gross_output_amount
            .checked_sub(fee_amount)
            .ok_or(ErrorCode::IntegerOverflowNetOutputAmount)?;

        // Validate slippage
        let slippage_value = net_output_amount
            .checked_mul(slippage as u128)
            .and_then(|v| v.checked_div(10000))
            .ok_or(ErrorCode::IntegerOverflowSlippageValue)?;

        let min_output_amount = net_output_amount
            .checked_sub(slippage_value)
            .ok_or(ErrorCode::IntegerOverflowMinOutputAmount)?;

        // Check that the user is receiving at least `min_output_amount`
        if net_output_amount.lt(&min_output_amount) {
            return Err(ErrorCode::InsufficientOutputAmount.into());
        }

        // Prepare signer seeds
        let seeds: &[&[u8]] = &[
            b"pool",
            // mint_a.as_ref(),
            mint_b.as_ref(),
            &[ctx.bumps.pool],
        ];
        let signer = &[seeds];

        // Transfer Token B from user to pool
        let transfer_to_pool = spl_token::instruction::transfer(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.user_token_a_ata.key(), 
            &ctx.accounts.pool_token_a_ata.key(),
            &ctx.accounts.user.key(),
            &[],
            amount as u64
        )?;

        invoke_signed(
            &transfer_to_pool,
            &[
                ctx.accounts.token_program.to_account_info().clone(),
                ctx.accounts.user_token_a_ata.to_account_info().clone(),
                ctx.accounts.pool_token_a_ata.to_account_info().clone(),
                ctx.accounts.user.to_account_info().clone(),
            ],
            signer
        )?;

        // Transfer Token A from pool to user
        let transfer_tokens = spl_token::instruction::transfer(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.pool_token_b_ata.key(),
            &ctx.accounts.user_token_b_ata.key(),
            &ctx.accounts.pool.key(),
            &[],
            net_output_amount as u64,
        )?;
        
        invoke_signed(
            &transfer_tokens,
            &[
                ctx.accounts.token_program.to_account_info().clone(),
                ctx.accounts.pool_token_b_ata.to_account_info().clone(),
                ctx.accounts.user_token_b_ata.to_account_info().clone(),
                ctx.accounts.pool.to_account_info().clone(),
            ],
            signer,
        )?;

        // Constant product invariant check
        let simulated_input_reserve = input_reserve
            .checked_add(net_input) 
            .ok_or(ErrorCode::IntegerOverflow11)?;

        let simulated_output_reserve = output_reserve
            .checked_sub(net_output_amount) 
            .ok_or(ErrorCode::IntegerOverflow11)?;

        let k_initial = input_reserve
            .checked_mul(output_reserve)
            .ok_or(ErrorCode::IntegerOverflow11)?;

        let k_final = simulated_input_reserve
            .checked_mul(simulated_output_reserve)
            .ok_or(ErrorCode::IntegerOverflow12)?;

        let difference = k_initial.saturating_sub(k_final);

        const MAX_DEVIATION_BPS: u128 = 1; // 0.001% || 0.1 BPS
        let max_allowed_difference = k_initial
            .checked_mul(MAX_DEVIATION_BPS)
            .and_then(|v| v.checked_div(100000))
            .ok_or(ErrorCode::IntegerOverflow12)?;

        if difference > max_allowed_difference {
            msg!(
                "Constant product violated beyond tolerance: k_initial={}, k_final={}, difference={}, max_allowed={}",
                k_initial,
                k_final,
                difference,
                max_allowed_difference
            );
            return Err(ErrorCode::ConstantProductInvariantViolated.into());
        }

        msg!(
            "User sold {} tokens for {} tokens with slippage tolerance {:.2}%",
            swap.amount, 
            net_output_amount as u64,
            slippage as f64 / 100.0
        );

        Ok(())
    }

    // #[inline(never)]
    pub fn add_liquidity(ctx: Context<AddLiquidity>,  amount_one: u64, amount_two: u64) -> Result<()> {
        // you have to create checks for some of these params like fee
        let pool = &mut ctx.accounts.pool;
       
        let total_liquidity = pool.total_liquidity as u128;
        let mint_a = ctx.accounts.mint_a.key();
        let mint_b = ctx.accounts.mint_b.key();

        // Fetch current reserves
        let reserve_a = ctx.accounts.pool_token_a.amount as u128;
        let reserve_b = ctx.accounts.pool_token_b.amount as u128;

        let amount_a = amount_one as u128;
        let amount_b = amount_two as u128;

        // Check if we're maintaining pool ratios based on existing reserves
        let (required_amount_a, required_amount_b) = if total_liquidity > 0 {
            // Ensure that reserve_a is not zero to avoid division by zero
            if reserve_a == 0 {
                return Err(ErrorCode::ZeroReserve.into());
            }

            // Calculate `required_amount_b` based on `amount_a` to maintain pool ratio
            let balanced_amount_b = amount_a
                .checked_mul(reserve_b)
                .and_then(|result| result.checked_div(reserve_a))
                .ok_or(ErrorCode::Overflow)?;

            let require_b_amount = balanced_amount_b as u64;

            if amount_b < balanced_amount_b {
                // Not enough `Token B` provided to maintain the ratio
                return Err(ErrorCode::InsufficientTokenB.into());
            }

            (amount_a as u64, require_b_amount)
        } else {
            // This is the initial liquidity, so use `amount_a` and `amount_b` directly
            (amount_a as u64, amount_b as u64)
        };

        let user_balance_a = ctx.accounts.user_token_a.amount;
        let user_balance_b = ctx.accounts.user_token_b.amount;
    
        if user_balance_a < required_amount_a || user_balance_b < required_amount_b {
            return Err(ErrorCode::InsufficientFunds.into());
        }

        let seeds: &[&[u8]] = &[
            b"pool",
            // mint_a.as_ref(),
            mint_b.as_ref(),
            &[ctx.bumps.pool],
        ];
        let signer = &[seeds];

        // Transfer Token A from user to pool
        let token_a_to_pool = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                authority: ctx.accounts.user.to_account_info(),
                from: ctx.accounts.user_token_a.to_account_info(),
                to: ctx.accounts.pool_token_a.to_account_info(),
            }
        );
        transfer(token_a_to_pool, required_amount_a)?;

        // Transfer Token B from user to pool
        let token_b_to_pool = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                authority: ctx.accounts.user.to_account_info(),
                from: ctx.accounts.user_token_b.to_account_info(),
                to: ctx.accounts.pool_token_b.to_account_info(),
            }
        );
        transfer(token_b_to_pool, required_amount_b)?;

        // Calculate the LP tokens to mint for the user based on their contribution
        let lp_amount;
        if reserve_a == 0 && reserve_b == 0 {
            // Initialize the pool by minting LP tokens equal to `amount_a`
            lp_amount = amount_a;
        } else {
            let total_lp_supply_u128 = total_liquidity;

            // Calculate LP tokens for `amount_a`
            let lp_tokens_for_amount_a = amount_a
                .checked_mul(total_lp_supply_u128)
                .and_then(|res| res.checked_div(reserve_a))
                .ok_or(ErrorCode::Overflow)?;

            // Calculate LP tokens for `amount_b`
            let lp_tokens_for_amount_b = amount_b
                .checked_mul(total_lp_supply_u128)
                .and_then(|res| res.checked_div(reserve_b))
                .ok_or(ErrorCode::Overflow)?;

            // Take the minimum of both calculated LP tokens to maintain balance
            lp_amount = std::cmp::min(lp_tokens_for_amount_a, lp_tokens_for_amount_b);
        }

        // Mint LP tokens to user's LP token account
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    authority: pool.to_account_info(),
                    to: ctx.accounts.user_lp_token_account.to_account_info(),
                    mint: ctx.accounts.lp_mint.to_account_info(),
                },
                signer,
            ),
            lp_amount as u64,
        )?;

        // Update pool state: increase reserves and total liquidity
        pool.total_liquidity = pool
            .total_liquidity
            .checked_add(lp_amount)
            .ok_or(ErrorCode::Overflow)?;
        pool.lp_mint = ctx.accounts.lp_mint.key();

        msg!(
            "Add Liquidity: {} Tokens Of {} Token A and {} Tokens Of {} Token B", 
            required_amount_a, mint_a, required_amount_b, mint_b
        );

        Ok(())
    }

    // #[inline(never)]
    pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, liquidity: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let lp_amount = liquidity as u128;
        let total_liquidity = pool.total_liquidity as u128;
        let _mint_a = pool.mint_a.key();
        let mint_b = pool.mint_b.key();

        // Verify non-zero amounts
        require!(lp_amount > 0, ErrorCode::InvalidAmount);
        require!(total_liquidity > 0, ErrorCode::InsufficientLiquidity);
        
        // Verify user has enough LP tokens
        require!(
            liquidity <= ctx.accounts.user_lp_token_account.amount,
            ErrorCode::InsufficientLPTokens
        );

        // Calculate the amount of Token A and Token B to return to the user
        let pool_token_a_amount = ctx.accounts.pool_token_a.amount as u128;
        let pool_token_b_amount = ctx.accounts.pool_token_b.amount as u128;

        let amount_a = lp_amount
            .checked_mul(pool_token_a_amount)
            .ok_or(ErrorCode::OverflowRemoveLiquidityA)?
            .checked_div(total_liquidity)
            .ok_or(ErrorCode::OverflowRemoveLiquidityA)?;
            
        let amount_b = lp_amount
            .checked_mul(pool_token_b_amount)
            .ok_or(ErrorCode::OverflowRemoveLiquidityB)?
            .checked_div(total_liquidity)
            .ok_or(ErrorCode::OverflowRemoveLiquidityB)?;
           
        // Verify calculated amounts are non-zero
        require!(amount_a > 0, ErrorCode::InvalidCalculatedAmount);
        require!(amount_b > 0, ErrorCode::InvalidCalculatedAmount);

        // Define PDA seeds for signing
        let seeds: &[&[u8]] = &[
            b"pool",
            // mint_a.as_ref(),
            mint_b.as_ref(),
            &[ctx.bumps.pool],
        ];
        let signer = &[seeds];

        // Verify pool has sufficient tokens
        require!(
            pool_token_a_amount >= amount_a,
            ErrorCode::InsufficientPoolTokenA
        );
        require!(
            pool_token_b_amount >= amount_b,
            ErrorCode::InsufficientPoolTokenB
        );

        // Transfer Token A from pool to user
        let token_a_to_user = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pool_token_a.to_account_info(),
                to: ctx.accounts.user_token_a.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer,
        );
        transfer(token_a_to_user, amount_a as u64)?;

        // Transfer Token B from pool to user
        let token_b_to_user = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pool_token_b.to_account_info(),
                to: ctx.accounts.user_token_b.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer,
        );
        transfer(token_b_to_user, amount_b as u64)?;

        // Burn the user's LP tokens
        let burn_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.user_lp_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        burn(burn_ctx, liquidity)?;

        // Update pool state: decrease total liquidity
        pool.total_liquidity = total_liquidity
            .checked_sub(lp_amount)
            .ok_or(ErrorCode::Overflow)?;

        // Optional: Close user's LP token account if they have removed all their liquidity
        if ctx.accounts.user_lp_token_account.amount == 0 {
            let close_lp_account_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: ctx.accounts.user_lp_token_account.to_account_info(),
                    destination: ctx.accounts.user.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            );
            close_account(close_lp_account_ctx)?;
        }

        msg!("Remove Liquidity: {} LP tokens for {} token A and {} token B", 
            liquidity, amount_a, amount_b);

        Ok(())
    }
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(
        mut,
        has_one = lp_mint @ ErrorCode::InvalidLPMint,
        seeds = [
            b"pool", 
            // mint_a.key().as_ref(), 
            mint_b.key().as_ref()
        ],
        bump,
        constraint = pool_token_a.mint == pool.mint_a @ ErrorCode::InvalidPoolTokenA,
        constraint = pool_token_b.mint == pool.mint_b @ ErrorCode::InvalidPoolTokenB
    )]
    pub pool: Account<'info, PoolInfo>,

    #[account(mut)]
    pub mint_a: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub mint_b: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = pool_token_a.owner == pool.to_account_info().key() @ ErrorCode::InvalidPoolTokenAOwner
    )]
    pub pool_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = pool_token_b.owner == pool.to_account_info().key() @ ErrorCode::InvalidPoolTokenBOwner
    )]
    pub pool_token_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub lp_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_a.owner == user.key() @ ErrorCode::InvalidUserTokenA,
        constraint = user_token_a.mint == pool.mint_a @ ErrorCode::InvalidUserTokenAMint
    )]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_b.owner == user.key() @ ErrorCode::InvalidUserTokenB,
        constraint = user_token_b.mint == pool.mint_b @ ErrorCode::InvalidUserTokenBMint
    )]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_lp_token_account.owner == user.key() @ ErrorCode::InvalidUserLPOwner,
        constraint = user_lp_token_account.mint == lp_mint.key() @ ErrorCode::InvalidUserLPMint
    )]
    pub user_lp_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>
}

#[account]
pub struct PoolInfo {
    pub pool: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub lp_mint: Pubkey,
    pub fees: u64,
    pub total_liquidity: u128
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        seeds = [
            b"pool",
            // mint_a.key().as_ref(),
            mint_b.key().as_ref()
        ],
        bump,
        payer = user,
        space = 8 + std::mem::size_of::<PoolInfo>()
    )]
    pub pool: Box<Account<'info, PoolInfo>>,

    #[account(constraint = mint_a.key() != mint_b.key() @ ErrorCode::SameTokenPool)]
    pub mint_a: Box<Account<'info, Mint>>, // ADD SOME BOXING HERE
    pub mint_b: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint_a,
        associated_token::authority = pool,
    )]
    pub pool_token_a: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint_b,
        associated_token::authority = pool,
    )]
    pub pool_token_b: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(
        mut, 
        seeds = [
            b"pool", 
            // mint_a.key().as_ref(),
            mint_b.key().as_ref()
        ], 
        bump,
    )]
    pub pool: Box<Account<'info, PoolInfo>>,

    #[account(mut)]
    pub mint_a: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub mint_b: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = user_token_a.owner == user.key(),
        constraint = user_token_a.mint == mint_a.key()
    )]
    pub user_token_a: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_token_b.owner == user.key(),
        constraint = user_token_b.mint == mint_b.key()
    )]
    pub user_token_b: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = pool,
    )]
    pub pool_token_a: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = pool,
    )]
    pub pool_token_b: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        mint::decimals = 6,
        mint::authority = pool,
    )]
    pub lp_mint: Box<Account<'info, Mint>>,
    
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = lp_mint,
        associated_token::authority = user
    )]
    pub user_lp_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>
}

#[derive(Accounts)]
#[instruction(params: SellInstructionData)]
pub struct SellInstruction<'info> {
    // #[account(
    //     mut, 
    //     address = FEE_PUBKEY
    // )]
    // /// CHECK: Fuck Anchor
    // pub fee_collector: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [
            b"pool", 
            mint_a.key().as_ref(), 
            // mint_b.key().as_ref()
        ], 
        bump,
        // constraint = pool.pool != Pubkey::default() @ ErrorCode::PoolNotInitialized
    )]
    pub pool: Box<Account<'info, PoolInfo>>, 

    #[account(mut)]
    pub mint_a: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub mint_b: Box<Account<'info, Mint>>,

    // Pool's associated token accounts for Token A and Token B...
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = pool,
    )]
    pub pool_token_a_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = pool,
    )]
    pub pool_token_b_ata: Box<Account<'info, TokenAccount>>,

    // User's associated token accounts for Token A and Token B...
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint_a,
        associated_token::authority = user,
    )]
    pub user_token_a_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint_b,
        associated_token::authority = user,
    )]
    pub user_token_b_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(params: BuyInstructionData)]
pub struct BuyInstruction<'info> {
    // #[account(
    //     mut, 
    //     address = FEE_PUBKEY
    // )]
    // /// CHECK: Fuck Anchor
    // pub fee_collector: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [
            b"pool", 
            // mint_a.key().as_ref(), 
            mint_b.key().as_ref()
        ], 
        bump,
        // constraint = pool.pool != Pubkey::default() @ ErrorCode::PoolNotInitialized
    )]
    pub pool: Box<Account<'info, PoolInfo>>, 

    #[account(mut)]
    pub mint_a: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub mint_b: Box<Account<'info, Mint>>,

    // Pool's associated token accounts for Token A and Token B...
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = pool,
    )]
    pub pool_token_a_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = pool,
    )]
    pub pool_token_b_ata: Box<Account<'info, TokenAccount>>,

    // User's associated token accounts for Token A and Token B...
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint_a,
        associated_token::authority = user,
    )]
    pub user_token_a_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint_b,
        associated_token::authority = user,
    )]
    pub user_token_b_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Debug, Clone)]
pub struct BuyInstructionData {
    pub amount: u64,
    pub slippage: u64,
    pub is_buy: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Debug, Clone)]
pub struct SellInstructionData {
    pub amount: u64,
    pub slippage: u64,
    pub is_buy: bool,
}

#[error_code]
pub enum ErrorCode {
    MinPoolBalanceReached,
    PoolNotInitialized,
    InsufficientLiquidity,
    ConstantProductInvariantViolated,
    ZeroReserve,
    PoolFrozen,
    InsufficientFunds,
    InsufficientOutputAmount,
    InvalidDecimals,
    EmptyInstructionData,
    InvalidInstruction,
    InvalidInstructionLength,
    ArithmeticOverflow,
    InvalidCalculatedAmount,
    InsufficientPoolTokenA,
    InsufficientPoolTokenB,
    InsufficientSolBalance,
    InvalidSolAmount,
    SolAmountTooMuch,
    TokenInfoNotFound,
    IntegerOverflowMinOutputAmount,
    IntegerOverflowSlippageValue, 
    IntegerOverflowNetOutputAmount, 
    IntegerOverflowNewOutputReserve, 
    OverflowRemoveLiquidityA,
    OverflowRemoveLiquidityB,
    IntegerOverflowK, 
    InvalidSwapAmount, 
    IntegerOverflowFeeAmount,
    FeeTooHigh,
    IntegerOverflowNetInput, 
    IntegerOverflowNewInputReserve,
    OutputAmountTooMuch,
    IntegerOverflow,
    IntegerOverflow11,
    IntegerOverflow12,
    InvalidSlippageValue,
    UserAccountNotBalanced,
    TokenAmountTooMuch,
    InvalidAmount,
    InsufficientTokenABalance,
    InsufficientLPTokens,
    InsufficientTokenBBalance,
    Unauthorized,
    Overflow,
    InsufficientTokenB,
     #[msg("Invalid LP mint account")]
    InvalidLPMint,
    #[msg("Invalid Pool Token A account")]
    InvalidPoolTokenA,
    #[msg("Invalid Pool Token B account")]
    InvalidPoolTokenB,
    #[msg("Invalid Pool Token A owner")]
    InvalidPoolTokenAOwner,
    #[msg("Invalid Pool Token B owner")]
    InvalidPoolTokenBOwner,
    #[msg("Invalid User Token A account")]
    InvalidUserTokenA,
    #[msg("Invalid User Token B account")]
    InvalidUserTokenB,
    #[msg("Invalid User LP Token account owner")]
    InvalidUserLPOwner,
    #[msg("Invalid User LP Token mint")]
    InvalidUserLPMint,
    InvalidUserTokenAMint,
    InvalidUserTokenBMint,
    SameTokenPool,
    InvalidTokenOrder
}