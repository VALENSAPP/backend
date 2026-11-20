import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
    Query,
    Req,
    UploadedFile,
    UploadedFiles,
    UseGuards,
    UseInterceptors,
    ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { SetAvailabilityDto } from '../dto/availability.dto';
import { ManageServicesQueryDto } from '../dto/query.dto';
import { CreateProServiceDto, UpdateProServiceDto } from '../dto/service.dto';
import { SetCohortsDto, SetTicketTypesDto } from '../dto/ticket-types.dto';
import { LIMITS } from '../pro-services.constants';
import { getUserId } from '../pro-services.utils';
import { CatalogService } from '../services/catalog.service';

const pipe = new ValidationPipe({ whitelist: true, transform: true });
const MB = 1024 * 1024;

/** Provider-side: create and manage my services (screens P4-P14). */
@ApiTags('pro-services: manage')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('pro-services/manage')
export class ManageController {
    constructor(private readonly catalog: CatalogService) { }

    @Get('meta/types')
    @ApiOperation({ summary: 'P4 - The 5 service types, fees, categories and wizard options' })
    getTypes() {
        return this.catalog.getTypesMeta();
    }

    @Post()
    @ApiOperation({
        summary: 'P5-P9 - Create a service as a draft (first wizard step)',
        description: 'Send `mentorship`, `package` or `event` only for that type. Price is in major units.',
    })
    create(@Req() req: Request, @Body(pipe) dto: CreateProServiceDto) {
        return this.catalog.create(getUserId(req), dto);
    }

    @Get()
    @ApiOperation({ summary: 'P14 - My services (not archived unless status=ARCHIVED)' })
    list(@Req() req: Request, @Query(pipe) query: ManageServicesQueryDto) {
        return this.catalog.listOwned(getUserId(req), query);
    }

    @Get(':id')
    @ApiOperation({ summary: 'One of my services, with everything the editor needs and the publish checklist' })
    get(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
        return this.catalog.getOwned(getUserId(req), id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'P5-P9 - Save a wizard step (send only the fields that changed)' })
    update(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body(pipe) dto: UpdateProServiceDto) {
        return this.catalog.update(getUserId(req), id, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Archive (delete) a service. Refused while it still has clients - pause it instead.' })
    archive(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
        return this.catalog.archive(getUserId(req), id);
    }

    @Post(':id/publish')
    @ApiOperation({
        summary: 'P12 - Publish (or resume) a service',
        description: 'Needs membership, KYC and a payout account. Returns code SERVICE_INCOMPLETE + problems[] if fields are missing.',
    })
    publish(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
        return this.catalog.publish(getUserId(req), id);
    }

    @Post(':id/pause')
    @ApiOperation({ summary: 'Pause a live service (hidden from new buyers; existing bookings stay)' })
    pause(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
        return this.catalog.pause(getUserId(req), id);
    }

    @Get(':id/availability')
    @ApiOperation({ summary: 'P10 - Weekly time slots and days off' })
    getAvailability(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
        return this.catalog.getAvailability(getUserId(req), id);
    }

    @Put(':id/availability')
    @ApiOperation({ summary: 'P10 - Replace weekly time slots and days off (times in the service time zone)' })
    setAvailability(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body(pipe) dto: SetAvailabilityDto) {
        return this.catalog.setAvailability(getUserId(req), id, dto);
    }

    @Put(':id/ticket-types')
    @ApiOperation({
        summary: 'P8 - Replace event ticket types',
        description: 'Send the full list. Types left out are deleted, or deactivated if tickets were sold.',
    })
    setTicketTypes(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body(pipe) dto: SetTicketTypesDto) {
        return this.catalog.setTicketTypes(getUserId(req), id, dto);
    }

    @Put(':id/cohorts')
    @ApiOperation({
        summary: 'P5 - Replace mentorship cohort start dates',
        description: 'Send the full list. Cohorts left out are deleted, or deactivated if people joined.',
    })
    setCohorts(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body(pipe) dto: SetCohortsDto) {
        return this.catalog.setCohorts(getUserId(req), id, dto);
    }

    @Post(':id/cover')
    @UseInterceptors(FileInterceptor('cover', { limits: { fileSize: 10 * MB } }))
    @ApiConsumes('multipart/form-data')
    @ApiBody({ schema: { type: 'object', required: ['cover'], properties: { cover: { type: 'string', format: 'binary' } } } })
    @ApiOperation({ summary: 'P11 - Upload the cover image (JPG, PNG, WEBP, HEIC, max 10 MB)' })
    uploadCover(
        @Req() req: Request,
        @Param('id', ParseUUIDPipe) id: string,
        @UploadedFile() file?: Express.Multer.File,
    ) {
        return this.catalog.uploadCover(getUserId(req), id, file);
    }

    @Post(':id/attachments')
    @UseInterceptors(FilesInterceptor('files', LIMITS.attachmentsMax, { limits: { fileSize: 200 * MB } }))
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            required: ['files'],
            properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } },
        },
    })
    @ApiOperation({ summary: 'P9/P11 - Add PDF / video / image files (shown to buyers after purchase)' })
    addAttachments(
        @Req() req: Request,
        @Param('id', ParseUUIDPipe) id: string,
        @UploadedFiles() files: Express.Multer.File[],
    ) {
        return this.catalog.addAttachments(getUserId(req), id, files);
    }

    @Delete(':id/attachments/:attachmentId')
    @ApiOperation({ summary: 'Remove an attachment' })
    deleteAttachment(
        @Req() req: Request,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    ) {
        return this.catalog.deleteAttachment(getUserId(req), id, attachmentId);
    }
}
