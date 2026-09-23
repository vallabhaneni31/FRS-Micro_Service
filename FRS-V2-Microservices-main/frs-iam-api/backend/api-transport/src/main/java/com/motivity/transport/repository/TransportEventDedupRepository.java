package com.motivity.transport.repository;

import com.motivity.transport.entity.TransportEventDedup;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface TransportEventDedupRepository extends JpaRepository<TransportEventDedup, UUID> {
}
