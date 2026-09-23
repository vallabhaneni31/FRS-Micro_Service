package com.motivity.transport;

import com.motivity.transport.entity.Bus;
import com.motivity.transport.repository.BusRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.Rollback;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Phase 2b verification, kept as a real (not throwaway) test so it can run
 * again in CI later — proves both datasources actually work end to end,
 * not just that the app boots.
 *
 * Requires TRANSPORT_DB_* and FRS_DB_* env vars pointing at real reachable
 * databases (see .env.transport.local, not committed).
 */
@SpringBootTest
class DatabaseLayerSmokeTest {

    @Autowired
    private BusRepository busRepository;

    @Autowired
    @Qualifier("frsJdbcTemplate")
    private JdbcTemplate frsJdbcTemplate;

    // @Transactional + @Rollback: the round trip really hits Postgres, but
    // nothing is left behind in transport_intelligence afterward.
    @Test
    @Transactional
    @Rollback
    void writesAndReadsABusInTheIsolatedTransportDatabase() {
        UUID tenantId = UUID.randomUUID();
        Bus saved = busRepository.save(Bus.builder()
                .tenantId(tenantId)
                .busCode("SMOKE-TEST-01")
                .capacity(40)
                .build());

        Bus fetched = busRepository.findByIdAndTenantId(saved.getId(), tenantId).orElseThrow();

        assertThat(fetched.getBusCode()).isEqualTo("SMOKE-TEST-01");
        assertThat(fetched.getStatus()).isEqualTo("active"); // DB/entity default applied
        assertThat(fetched.getTenantId()).isEqualTo(tenantId);
    }

    @Test
    void canReadTenantsFromTheExistingPlatformDatabaseReadOnly() {
        Integer count = frsJdbcTemplate.queryForObject("SELECT count(*) FROM tenants", Integer.class);
        assertThat(count).isNotNull();
        assertThat(count).isGreaterThan(0); // real platform data — proves this is actually the shared DB, not an empty stand-in
    }

    @Test
    void theReadOnlyPoolActuallyRejectsWrites() {
        // WHERE 1=0 so even if the read-only guard somehow failed, this
        // changes zero rows — the test's safety does not depend on the
        // assertion below being reached.
        assertThatThrownBy(() ->
                frsJdbcTemplate.update("UPDATE tenants SET name = name WHERE 1 = 0")
        ).isInstanceOf(Exception.class);
    }
}
