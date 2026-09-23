package com.motivity.transport.service;

import com.motivity.transport.dto.TransportDeviceCreatedResponse;
import com.motivity.transport.dto.TransportDeviceRequest;
import com.motivity.transport.dto.TransportDeviceResponse;
import com.motivity.transport.entity.Bus;
import com.motivity.transport.entity.TransportDevice;
import com.motivity.transport.exception.InvalidReferenceException;
import com.motivity.transport.exception.NotFoundException;
import com.motivity.transport.repository.BusRepository;
import com.motivity.transport.repository.TransportDeviceRepository;
import com.motivity.transport.security.TransportScope;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

/**
 * Devices have no depot_id of their own — depot scoping goes through the
 * owning bus's depot_id (see TransportDeviceRepository.findAllByTenantIdAndBusDepotId
 * and requireBusInScope below). Mirrors BusService's scope handling otherwise.
 */
@Service
public class TransportDeviceService {

    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private final TransportDeviceRepository deviceRepository;
    private final BusRepository busRepository;

    public TransportDeviceService(TransportDeviceRepository deviceRepository, BusRepository busRepository) {
        this.deviceRepository = deviceRepository;
        this.busRepository = busRepository;
    }

    public List<TransportDeviceResponse> list(TransportScope scope, UUID busId) {
        List<TransportDevice> devices = switch (scope.level()) {
            case TENANT_WIDE -> busId != null
                    ? deviceRepository.findAllByTenantIdAndBusId(scope.tenantId(), busId)
                    : deviceRepository.findAllByTenantId(scope.tenantId());
            case DEPOT -> {
                List<TransportDevice> inDepot = deviceRepository.findAllByTenantIdAndBusDepotId(scope.tenantId(), scope.depotId());
                yield busId == null ? inDepot : inDepot.stream().filter(d -> busId.equals(d.getBusId())).toList();
            }
            // hr_manager never holds DEVICES_READ today — unreachable via
            // the @PreAuthorize gate, empty here purely as a defensive default.
            case BUS, UNASSIGNED -> List.of();
        };
        return devices.stream().map(TransportDeviceResponse::from).toList();
    }

    public TransportDeviceResponse get(TransportScope scope, UUID id) {
        return TransportDeviceResponse.from(requireInScope(scope, id));
    }

    @Transactional
    public TransportDeviceCreatedResponse create(TransportScope scope, TransportDeviceRequest request) {
        if (request.busId() == null) {
            throw new IllegalArgumentException("busId is required");
        }
        if (request.deviceCode() == null || request.deviceCode().isBlank()) {
            throw new IllegalArgumentException("deviceCode is required");
        }
        if (request.cameraPosition() == null) {
            throw new IllegalArgumentException("cameraPosition is required");
        }
        requireBusInScope(scope, request.busId());

        String secret = generateSecret();
        TransportDevice device = TransportDevice.builder()
                .tenantId(scope.tenantId())
                .busId(request.busId())
                .deviceCode(request.deviceCode())
                .deviceSecret(secret)
                .cameraPosition(request.cameraPosition())
                .status(request.status() != null ? request.status() : "active")
                .build();
        TransportDevice saved = deviceRepository.save(device);
        return new TransportDeviceCreatedResponse(TransportDeviceResponse.from(saved), secret);
    }

    // PATCH semantics — never touches device_secret; that's rotateSecret's job alone.
    @Transactional
    public TransportDeviceResponse update(TransportScope scope, UUID id, TransportDeviceRequest request) {
        TransportDevice device = requireInScope(scope, id);

        if (request.busId() != null) {
            requireBusInScope(scope, request.busId());
            device.setBusId(request.busId());
        }
        if (request.deviceCode() != null) device.setDeviceCode(request.deviceCode());
        if (request.cameraPosition() != null) device.setCameraPosition(request.cameraPosition());
        if (request.status() != null) device.setStatus(request.status());

        return TransportDeviceResponse.from(deviceRepository.save(device));
    }

    @Transactional
    public TransportDeviceCreatedResponse rotateSecret(TransportScope scope, UUID id) {
        TransportDevice device = requireInScope(scope, id);
        String newSecret = generateSecret();
        device.setDeviceSecret(newSecret);
        TransportDevice saved = deviceRepository.save(device);
        return new TransportDeviceCreatedResponse(TransportDeviceResponse.from(saved), newSecret);
    }

    @Transactional
    public TransportDeviceResponse decommission(TransportScope scope, UUID id) {
        TransportDevice device = requireInScope(scope, id);
        device.setDecommissionedAt(OffsetDateTime.now());
        device.setStatus("offline");
        return TransportDeviceResponse.from(deviceRepository.save(device));
    }

    private TransportDevice requireInScope(TransportScope scope, UUID id) {
        TransportDevice device = deviceRepository.findByIdAndTenantId(id, scope.tenantId())
                .orElseThrow(() -> new NotFoundException("device not found: " + id));
        if (!busInScope(scope, device.getBusId())) {
            throw new NotFoundException("device not found: " + id);
        }
        return device;
    }

    // transport_devices.bus_id has no tenant-aware foreign key at the
    // database level — a device must never be linkable to another
    // tenant's bus. For a DEPOT-scoped caller, the bus must additionally
    // belong to their own depot — a Route Manager cannot register a
    // device against a bus outside their scope even if they somehow knew
    // its id.
    private void requireBusInScope(TransportScope scope, UUID busId) {
        Bus bus = busRepository.findByIdAndTenantId(busId, scope.tenantId())
                .orElseThrow(() -> new InvalidReferenceException("busId does not belong to your tenant: " + busId));
        boolean inScope = switch (scope.level()) {
            case TENANT_WIDE -> true;
            case DEPOT -> scope.depotId().equals(bus.getDepotId());
            case BUS -> scope.busId().equals(bus.getId());
            case UNASSIGNED -> false;
        };
        if (!inScope) {
            throw new InvalidReferenceException("busId does not belong to your depot: " + busId);
        }
    }

    private boolean busInScope(TransportScope scope, UUID busId) {
        return switch (scope.level()) {
            case TENANT_WIDE -> true;
            case DEPOT -> busRepository.findByIdAndTenantId(busId, scope.tenantId())
                    .map(b -> scope.depotId().equals(b.getDepotId())).orElse(false);
            case BUS -> scope.busId().equals(busId);
            case UNASSIGNED -> false;
        };
    }

    private String generateSecret() {
        byte[] bytes = new byte[32]; // 256 bits — comfortably above HS256's minimum key length
        SECURE_RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }
}
