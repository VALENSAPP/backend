import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CartItemShippingChoice, ShippingOptions } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertUserKyc } from '../../common/kyc.util';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemShippingChoiceDto } from './dto/update-cart-item-shipping-choice.dto';
import { UpdateCartItemQuantityDto } from './dto/update-cart-item-quantity.dto';

@Injectable()
export class CartService {
    constructor(private readonly prisma: PrismaService) { }

    private roundMoney(amount: number) {
        return Number(amount.toFixed(2));
    }

    private resolveShippingSelection(
        sellerShippingOption: ShippingOptions,
        selectedChoice: CartItemShippingChoice | null | undefined,
        shippingFee: number | null | undefined,
    ) {
        const normalizedShippingFee = this.roundMoney(shippingFee ?? 0);

        if (sellerShippingOption === 'both') {
            if (!selectedChoice) {
                return {
                    selectedShippingChoice: null,
                    selectedShippingFee: 0,
                };
            }

            if (selectedChoice === 'ship_items') {
                return {
                    selectedShippingChoice: CartItemShippingChoice.ship_items,
                    selectedShippingFee: normalizedShippingFee,
                };
            }

            return {
                selectedShippingChoice: CartItemShippingChoice.local_pick,
                selectedShippingFee: 0,
            };
        }

        if (sellerShippingOption === 'ship_items') {
            if (selectedChoice && selectedChoice !== CartItemShippingChoice.ship_items) {
                throw new BadRequestException('Only shipping_items is allowed for this product');
            }

            return {
                selectedShippingChoice: CartItemShippingChoice.ship_items,
                selectedShippingFee: normalizedShippingFee,
            };
        }

        if (selectedChoice && selectedChoice !== CartItemShippingChoice.local_pick) {
            throw new BadRequestException('Only local_pick is allowed for this product');
        }

        return {
            selectedShippingChoice: CartItemShippingChoice.local_pick,
            selectedShippingFee: 0,
        };
    }

    private async ensureUserExists(userId: string) {
        if (!userId) throw new BadRequestException('User ID required');

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true },
        });

        if (!user) throw new NotFoundException('User not found');
    }

    private async getOrCreateCart(userId: string, sellerId: string, closetId: string) {
        const existingCart = await this.prisma.cart.findFirst({
            where: { userId, sellerId, closetId },
            orderBy: { createdAt: 'desc' },
            select: { id: true, userId: true, sellerId: true, closetId: true },
        });

        if (existingCart) return existingCart;

        return this.prisma.cart.create({
            data: { userId, sellerId, closetId },
            select: { id: true, userId: true, sellerId: true, closetId: true },
        });
    }

    async addItem(userId: string, dto: AddCartItemDto) {
        await this.ensureUserExists(userId);

        const product = await this.prisma.closetItems.findUnique({
            where: { id: dto.productId },
            select: {
                id: true,
                userId: true,
                closetId: true,
                quantity: true,
                price: true,
                name: true,
                shippingOption: true,
                shippingFee: true,
                isActive: true,
                isDeleted: true,
            },
        });

        if (!product || !product.isActive || product.isDeleted) throw new NotFoundException('Product not found');
        if (product.userId === userId) throw new BadRequestException('You cannot add your own product to cart');
        if (dto.quantity > product.quantity) {
            throw new BadRequestException('Requested quantity exceeds available stock');
        }

        const cart = await this.getOrCreateCart(userId, product.userId, product.closetId);

        const existingItem = await this.prisma.cartItems.findUnique({
            where: {
                cartId_productId: {
                    cartId: cart.id,
                    productId: product.id,
                },
            },
            select: { id: true, quantity: true, selectedShippingChoice: true },
        });

        const nextQuantity = existingItem ? existingItem.quantity + dto.quantity : dto.quantity;
        if (nextQuantity > product.quantity) {
            throw new BadRequestException('Requested quantity exceeds available stock');
        }

        const subtotal = Number((nextQuantity * product.price).toFixed(2));
        const shippingSelection = this.resolveShippingSelection(
            product.shippingOption,
            existingItem?.selectedShippingChoice,
            product.shippingFee,
        );

        if (existingItem) {
            await this.prisma.cartItems.update({
                where: { id: existingItem.id },
                data: {
                    quantity: nextQuantity,
                    price: product.price,
                    subtotal,
                    selectedShippingChoice: shippingSelection.selectedShippingChoice,
                    selectedShippingFee: shippingSelection.selectedShippingFee,
                },
            });
        } else {
            await this.prisma.cartItems.create({
                data: {
                    cartId: cart.id,
                    productId: product.id,
                    quantity: nextQuantity,
                    price: product.price,
                    subtotal,
                    selectedShippingChoice: shippingSelection.selectedShippingChoice,
                    selectedShippingFee: shippingSelection.selectedShippingFee,
                },
            });
        }

        return this.getCart(userId);
    }

    async getCart(userId: string, sellerId?: string) {
        await this.ensureUserExists(userId);

        const carts = await this.prisma.cart.findMany({
            where: {
                userId,
                ...(sellerId ? { sellerId } : {}),
            },
            orderBy: { createdAt: 'desc' },
            include: {
                cartItems: {
                    orderBy: { createdAt: 'desc' },
                    include: {
                        product: {
                            select: {
                                id: true,
                                name: true,
                                category: true,
                                brand: true,
                                images: true,
                                price: true,
                                quantity: true,
                                shippingOption: true,
                                shippingFee: true,
                            },
                        },
                    },
                },
            },
        });

        if (!carts.length) {
            return {
                carts: [],
                totals: {
                    totalItems: 0,
                    totalAmount: 0,
                    totalCarts: 0,
                },
            };
        }

        const totalItems = carts.reduce(
            (sum, cart) => sum + cart.cartItems.reduce((itemSum, item) => itemSum + item.quantity, 0),
            0,
        );
        const totalAmount = Number(
            carts
                .reduce((sum, cart) => sum + cart.cartItems.reduce((itemSum, item) => itemSum + item.subtotal, 0), 0)
                .toFixed(2),
        );

        const cartGroups = carts.map((cart) => {
            const groupTotalItems = cart.cartItems.reduce((sum, item) => sum + item.quantity, 0);
            const groupTotalAmount = Number(cart.cartItems.reduce((sum, item) => sum + item.subtotal, 0).toFixed(2));

            return {
                ...cart,
                totals: {
                    totalItems: groupTotalItems,
                    totalAmount: groupTotalAmount,
                },
            };
        });

        return {
            carts: cartGroups,
            totals: {
                totalItems,
                totalAmount,
                totalCarts: carts.length,
            },
        };
    }

    async updateQuantity(userId: string, cartItemId: string, dto: UpdateCartItemQuantityDto) {
        await this.ensureUserExists(userId);
        if (!cartItemId) throw new BadRequestException('Cart item ID required');

        const cartItem = await this.prisma.cartItems.findUnique({
            where: { id: cartItemId },
            include: {
                cart: {
                    select: { id: true, userId: true },
                },
            },
        });

        if (!cartItem || cartItem.cart.userId !== userId) {
            throw new NotFoundException('Cart item not found');
        }

        const product = await this.prisma.closetItems.findUnique({
            where: { id: cartItem.productId },
            select: { id: true, quantity: true, price: true, shippingOption: true, shippingFee: true, isActive: true, isDeleted: true },
        });

        if (!product || !product.isActive || product.isDeleted) throw new NotFoundException('Product not found');
        if (dto.quantity > product.quantity) {
            throw new BadRequestException('Requested quantity exceeds available stock');
        }

        const subtotal = Number((dto.quantity * product.price).toFixed(2));
        const shippingSelection = this.resolveShippingSelection(
            product.shippingOption,
            cartItem.selectedShippingChoice,
            product.shippingFee,
        );

        await this.prisma.cartItems.update({
            where: { id: cartItem.id },
            data: {
                quantity: dto.quantity,
                price: product.price,
                subtotal,
                selectedShippingChoice: shippingSelection.selectedShippingChoice,
                selectedShippingFee: shippingSelection.selectedShippingFee,
            },
        });

        return this.getCart(userId);
    }

    async updateShippingChoice(userId: string, cartItemId: string, dto: UpdateCartItemShippingChoiceDto) {
        await this.ensureUserExists(userId);
        if (!cartItemId) throw new BadRequestException('Cart item ID required');

        const cartItem = await this.prisma.cartItems.findUnique({
            where: { id: cartItemId },
            include: {
                cart: {
                    select: { userId: true },
                },
                product: {
                    select: {
                        id: true,
                        name: true,
                        isActive: true,
                        isDeleted: true,
                        shippingOption: true,
                        shippingFee: true,
                    },
                },
            },
        });

        if (!cartItem || cartItem.cart.userId !== userId) {
            throw new NotFoundException('Cart item not found');
        }

        if (!cartItem.product || !cartItem.product.isActive || cartItem.product.isDeleted) {
            throw new BadRequestException('Product is unavailable for shipping selection');
        }

        const shippingSelection = this.resolveShippingSelection(
            cartItem.product.shippingOption,
            dto.shippingChoice,
            cartItem.product.shippingFee,
        );

        await this.prisma.cartItems.update({
            where: { id: cartItem.id },
            data: {
                selectedShippingChoice: shippingSelection.selectedShippingChoice,
                selectedShippingFee: shippingSelection.selectedShippingFee,
            },
        });

        return this.getCart(userId);
    }

    async removeItem(userId: string, cartItemId: string) {
        await this.ensureUserExists(userId);
        if (!cartItemId) throw new BadRequestException('Cart item ID required');

        const cartItem = await this.prisma.cartItems.findUnique({
            where: { id: cartItemId },
            include: {
                cart: {
                    select: { userId: true },
                },
            },
        });

        if (!cartItem || cartItem.cart.userId !== userId) {
            throw new NotFoundException('Cart item not found');
        }

        await this.prisma.cartItems.delete({
            where: { id: cartItem.id },
        });

        return this.getCart(userId);
    }

    async deleteCart(userId: string) {
        await this.ensureUserExists(userId);

        const carts = await this.prisma.cart.findMany({
            where: { userId },
            select: { id: true },
        });

        if (!carts.length) {
            return { message: 'Cart not found' };
        }

        const cartIds = carts.map((cart) => cart.id);

        await this.prisma.$transaction([
            this.prisma.cartItems.deleteMany({
                where: { cartId: { in: cartIds } },
            }),
            this.prisma.cart.deleteMany({
                where: { id: { in: cartIds } },
            }),
        ]);

        return { message: 'Cart deleted successfully' };
    }

    async inspectCheckout(userId: string, cartId?: string) {
        await this.ensureUserExists(userId);
        await assertUserKyc(this.prisma, userId, 'PAYER');

        const cart = await this.prisma.cart.findFirst({
            where: { userId, ...(cartId ? { id: cartId } : {}) },
            orderBy: { createdAt: 'desc' },
            include: {
                cartItems: {
                    orderBy: { createdAt: 'desc' },
                    include: {
                        product: {
                            select: {
                                id: true,
                                userId: true,
                                name: true,
                                price: true,
                                quantity: true,
                                shippingOption: true,
                                shippingFee: true,
                                isActive: true,
                                isDeleted: true,
                            },
                        },
                    },
                },
            },
        });

        if (cart && cart.cartItems?.length) {
            const sellerIds = [...new Set(cart.cartItems.map((item) => item.product?.userId).filter(Boolean))];
            for (const sellerId of sellerIds) {
                await assertUserKyc(this.prisma, sellerId, 'RECEIVER');
            }
        }

        if (!cart || !cart.cartItems.length) {
            throw new BadRequestException('Cart is empty');
        }

        const items: Array<{
            cartItemId: string;
            productId: string;
            productName: string;
            requestedQuantity: number;
            approvedQuantity: number;
            unitPrice: number;
            lineTotal: number;
            sellerShippingOption: string;
            selectedShippingChoice: CartItemShippingChoice | null;
            lineShippingFee: number;
        }> = [];

        const issues: Array<{
            cartItemId: string;
            productId: string;
            code: string;
            message: string;
        }> = [];

        const warnings: Array<{
            cartItemId: string;
            productId: string;
            code: string;
            message: string;
        }> = [];

        let itemsSubtotal = 0;
        let shippingAmount = 0;
        let totalItems = 0;

        for (const cartItem of cart.cartItems) {
            const product = cartItem.product;

            if (!product || !product.isActive || product.isDeleted) {
                issues.push({
                    cartItemId: cartItem.id,
                    productId: cartItem.productId,
                    code: 'PRODUCT_NOT_FOUND',
                    message: 'This product is no longer available.',
                });
                continue;
            }

            if (product.userId === userId) {
                issues.push({
                    cartItemId: cartItem.id,
                    productId: product.id,
                    code: 'SELF_PURCHASE_NOT_ALLOWED',
                    message: 'You cannot purchase your own product.',
                });
                continue;
            }

            if (product.quantity <= 0) {
                issues.push({
                    cartItemId: cartItem.id,
                    productId: product.id,
                    code: 'OUT_OF_STOCK',
                    message: 'This product is out of stock.',
                });
                continue;
            }

            if (cartItem.quantity > product.quantity) {
                issues.push({
                    cartItemId: cartItem.id,
                    productId: product.id,
                    code: 'INSUFFICIENT_STOCK',
                    message: `Requested quantity (${cartItem.quantity}) exceeds available stock (${product.quantity}).`,
                });
                continue;
            }

            if (Math.abs(cartItem.price - product.price) > 0.000001) {
                warnings.push({
                    cartItemId: cartItem.id,
                    productId: product.id,
                    code: 'PRICE_UPDATED',
                    message: `Price changed from ${cartItem.price} to ${product.price}. Latest price applied.`,
                });
            }

            const unitPrice = this.roundMoney(product.price);
            const lineTotal = this.roundMoney(unitPrice * cartItem.quantity);
            const normalizedProductShippingFee = this.roundMoney(product.shippingFee ?? 0);

            let selectedShippingChoice: CartItemShippingChoice | null = cartItem.selectedShippingChoice;
            let lineShippingFee = 0;

            if (product.shippingOption === 'both') {
                if (!selectedShippingChoice) {
                    issues.push({
                        cartItemId: cartItem.id,
                        productId: product.id,
                        code: 'SHIPPING_CHOICE_REQUIRED',
                        message: 'Select shipping option (ship_items or local_pick) for this item.',
                    });
                    continue;
                }

                if (selectedShippingChoice === CartItemShippingChoice.ship_items) {
                    lineShippingFee = this.roundMoney(normalizedProductShippingFee * cartItem.quantity);
                } else {
                    lineShippingFee = 0;
                }
            } else if (product.shippingOption === 'ship_items') {
                if (selectedShippingChoice && selectedShippingChoice !== CartItemShippingChoice.ship_items) {
                    issues.push({
                        cartItemId: cartItem.id,
                        productId: product.id,
                        code: 'INVALID_SHIPPING_CHOICE',
                        message: 'Only ship_items is allowed for this item.',
                    });
                    continue;
                }

                selectedShippingChoice = CartItemShippingChoice.ship_items;
                lineShippingFee = this.roundMoney(normalizedProductShippingFee * cartItem.quantity);
            } else {
                if (selectedShippingChoice && selectedShippingChoice !== CartItemShippingChoice.local_pick) {
                    issues.push({
                        cartItemId: cartItem.id,
                        productId: product.id,
                        code: 'INVALID_SHIPPING_CHOICE',
                        message: 'Only local_pick is allowed for this item.',
                    });
                    continue;
                }

                selectedShippingChoice = CartItemShippingChoice.local_pick;
                lineShippingFee = 0;
            }

            items.push({
                cartItemId: cartItem.id,
                productId: product.id,
                productName: product.name,
                requestedQuantity: cartItem.quantity,
                approvedQuantity: cartItem.quantity,
                unitPrice,
                lineTotal,
                sellerShippingOption: product.shippingOption,
                selectedShippingChoice,
                lineShippingFee,
            });

            totalItems += cartItem.quantity;
            itemsSubtotal = this.roundMoney(itemsSubtotal + lineTotal);
            shippingAmount = this.roundMoney(shippingAmount + lineShippingFee);
        }

        if (!items.length) {
            throw new BadRequestException({
                message: 'Checkout is not possible. Please update your cart.',
                issues,
            });
        }

        const taxAmount = 0;
        const platformFee = 0;
        const discountAmount = 0;
        const totalAmountDue = this.roundMoney(
            itemsSubtotal + shippingAmount + taxAmount + platformFee - discountAmount,
        );

        return {
            checkout: {
                isValid: issues.length === 0,
                currency: 'USD',
                checkedAt: new Date().toISOString(),
                totalItems,
                items,
                issues,
                warnings,
                breakdown: {
                    itemsSubtotal,
                    shippingAmount,
                    taxAmount,
                    platformFee,
                    discountAmount,
                    totalAmountDue,
                },
            },
        };
    }
}
