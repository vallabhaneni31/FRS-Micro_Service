package com.motivity.transport.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

/**
 * Secondary connection into the EXISTING platform database
 * (attendance_intelligence) — read-only, used only to confirm a tenant_id is
 * real and resolve its vertical/realm slug (mirrors backend/api-retail's
 * frsPool, see architecture plan §2).
 *
 * Deliberately plain JdbcTemplate, not a JPA entity/repository: there is no
 * ORM write path into this datasource because no entity is ever mapped to
 * it. setReadOnly(true) on the pool additionally makes Postgres itself
 * reject writes for every connection this pool hands out (PgJDBC issues
 * "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"), not just
 * "the application code happens not to call a write method."
 *
 * This is the ONLY connection this service ever opens to the existing
 * shared database — everything else lives in the primary datasource
 * (transport_intelligence, auto-configured by Spring Boot from
 * spring.datasource.* below, see application.yml).
 */
@Configuration
public class FrsReadOnlyDataSourceConfig {

    @Bean(name = "frsDataSource")
    public DataSource frsDataSource(
            @Value("${frs.datasource.url}") String url,
            @Value("${frs.datasource.username}") String username,
            @Value("${frs.datasource.password}") String password) {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(url);
        config.setUsername(username);
        config.setPassword(password);
        config.setMaximumPoolSize(5);
        config.setReadOnly(true);
        // pgjdbc's default readOnlyMode ("transaction") only enforces
        // setReadOnly(true) inside an explicit (autoCommit=false)
        // transaction — in the default autocommit mode every JdbcTemplate
        // call is its own implicit transaction, and setReadOnly(true) alone
        // turned out to be silently advisory (caught by a test in phase 2b:
        // an UPDATE with a WHERE 1=0 clause did not throw). "always" makes
        // pgjdbc enforce it unconditionally, regardless of commit mode.
        config.addDataSourceProperty("readOnlyMode", "always");
        config.setPoolName("frs-readonly-pool");
        return new HikariDataSource(config);
    }

    @Bean(name = "frsJdbcTemplate")
    public JdbcTemplate frsJdbcTemplate(@Qualifier("frsDataSource") DataSource frsDataSource) {
        return new JdbcTemplate(frsDataSource);
    }
}
