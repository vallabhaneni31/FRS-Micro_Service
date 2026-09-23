package com.motivity.transport.repository;

import com.motivity.transport.entity.AuditLogEntry;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface AuditLogRepository extends JpaRepository<AuditLogEntry, UUID> {
    Page<AuditLogEntry> findAllByTenantId(UUID tenantId, Pageable pageable);
}
