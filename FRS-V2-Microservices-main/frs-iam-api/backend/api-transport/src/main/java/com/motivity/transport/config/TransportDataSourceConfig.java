package com.motivity.transport.config;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

/**
 * Explicitly declares the primary (transport_intelligence) datasource and
 * marks it @Primary.
 *
 * Why this exists: with FrsReadOnlyDataSourceConfig also declaring a
 * DataSource bean, the context has two unqualified DataSource candidates.
 * Spring Boot's Flyway/JPA autoconfiguration resolves "the" datasource via
 * ObjectProvider#getIfUnique(), which returns null (ambiguous) unless
 * exactly one bean — or exactly one @Primary bean — exists. Without this,
 * that resolution was non-deterministic and picked the read-only
 * attendance_intelligence datasource instead, which very nearly pointed
 * Flyway at the live platform database (caught by Flyway's own
 * non-empty-schema guard, no damage done — but the root cause needed a
 * real fix, not a retry).
 *
 * Built from Spring Boot's own DataSourceProperties bean (already bound
 * from spring.datasource.* by DataSourceAutoConfiguration) rather than a
 * bare @ConfigurationProperties-bound builder — DataSourceProperties'
 * initializeDataSourceBuilder() is what actually knows how to translate
 * "url" into HikariDataSource's jdbcUrl; plain relaxed binding onto an
 * unconfigured builder does not (first attempt at this failed with
 * "jdbcUrl is required" because of exactly that gap).
 */
@Configuration
public class TransportDataSourceConfig {

    @Primary
    @Bean(name = "dataSource")
    public DataSource transportDataSource(DataSourceProperties properties) {
        return properties.initializeDataSourceBuilder().build();
    }

    /**
     * Explicit, qualified JdbcTemplate bound to the transport_intelligence
     * datasource by name, not by relying on JdbcTemplateAutoConfiguration's
     * implicit @ConditionalOnSingleCandidate(DataSource.class) resolution.
     *
     * Added after that implicit resolution produced a SECOND bug in this
     * dual-datasource setup (the first was Flyway/JPA in 2b, both fixed by
     * making the primary datasource explicit and @Primary): even with
     * @Primary correctly set, an unqualified JdbcTemplate injected into
     * TransportEventProcessingService still ended up bound to the wrong
     * datasource at runtime — "bad SQL grammar" on a query against a table
     * that definitely exists in transport_intelligence, meaning the
     * connection wasn't actually pointed there. Root cause not fully
     * chased down because it didn't need to be: two separate ambiguity bugs
     * in the same implicit-resolution mechanism is reason enough to stop
     * trusting it here entirely, the same way frsJdbcTemplate was already
     * explicit and qualified from the start and never had this problem.
     */
    @Bean(name = "transportJdbcTemplate")
    public JdbcTemplate transportJdbcTemplate(@Qualifier("dataSource") DataSource dataSource) {
        return new JdbcTemplate(dataSource);
    }
}
