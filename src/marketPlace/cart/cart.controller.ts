import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
    Req,
    UseGuards,
    ValidationPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CartService } from './cart.service';
import { KycGuard } from '../../common/guards/kyc.guard';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemShippingChoiceDto } from './dto/update-cart-item-shipping-choice.dto';
import { UpdateCartItemQuantityDto } from './dto/update-cart-item-quantity.dto';

@ApiTags('cart')
@Controller('cart')
export class CartController {
    constructor(private readonly cartService: CartService) { }

    @Post('items')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Add item to cart' })
    async addItem(
        @Req() req: Request,
        @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: AddCartItemDto,
    ) {
        const userId = (req.user as any)?.userId;
        return this.cartService.addItem(userId, dto);
    }

    @Get()
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get authenticated user cart' })
    async getCart(@Req() req: Request, @Query('sellerId') sellerId?: string) {
        const userId = (req.user as any)?.userId;
        return this.cartService.getCart(userId, sellerId);
    }

    @Patch('items/:cartItemId')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiParam({ name: 'cartItemId', type: 'string' })
    @ApiOperation({ summary: 'Update cart item quantity' })
    async updateQuantity(
        @Req() req: Request,
        @Param('cartItemId') cartItemId: string,
        @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: UpdateCartItemQuantityDto,
    ) {
        const userId = (req.user as any)?.userId;
        return this.cartService.updateQuantity(userId, cartItemId, dto);
    }

    @Patch('items/:cartItemId/shipping-choice')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiParam({ name: 'cartItemId', type: 'string' })
    @ApiOperation({ summary: 'Set buyer shipping choice for a cart item' })
    async updateShippingChoice(
        @Req() req: Request,
        @Param('cartItemId') cartItemId: string,
        @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: UpdateCartItemShippingChoiceDto,
    ) {
        const userId = (req.user as any)?.userId;
        return this.cartService.updateShippingChoice(userId, cartItemId, dto);
    }

    @Delete('items/:cartItemId')
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiParam({ name: 'cartItemId', type: 'string' })
    @ApiOperation({ summary: 'Remove item from cart' })
    async removeItem(@Req() req: Request, @Param('cartItemId') cartItemId: string) {
        const userId = (req.user as any)?.userId;
        return this.cartService.removeItem(userId, cartItemId);
    }

    @Delete()
    @UseGuards(AuthGuard('jwt'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Delete authenticated user cart' })
    async deleteCart(@Req() req: Request) {
        const userId = (req.user as any)?.userId;
        return this.cartService.deleteCart(userId);
    }

    @Post('checkout')
    @UseGuards(AuthGuard('jwt'), KycGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Final checkout inspection: validate cart and calculate final payable amount' })
    async inspectCheckout(@Req() req: Request, @Query('cartId') cartId?: string) {
        const userId = (req.user as any)?.userId;
        return this.cartService.inspectCheckout(userId, cartId);
    }
}
