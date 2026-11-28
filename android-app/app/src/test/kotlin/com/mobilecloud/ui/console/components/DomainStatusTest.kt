package com.mobilecloud.ui.console.components

import com.mobilecloud.console.Domain
import com.mobilecloud.ui.console.Tone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The three domain signals must stay independent: a live domain with a down
 * origin reports a green lifecycle tone and a red health tone at the same time.
 */
class DomainStatusTest {

    private fun domain(
        host: String = "app.example.com",
        status: String = "pending_dns",
        dnsStatus: String = "pending",
        sslStatus: String = "none",
        healthStatus: String = "unknown",
        tunnelTarget: String? = null,
        verificationToken: String? = null,
    ) = Domain(
        id = "d1", host = host, project = "p", status = status, detail = "",
        dnsProvider = null, dnsStatus = dnsStatus, sslStatus = sslStatus, healthStatus = healthStatus,
        dnsVerifiedAt = null, sslExpiresAt = null, sslIssuer = null,
        tunnelTarget = tunnelTarget, verificationToken = verificationToken, verificationMethod = "cname",
        lastError = null, createdAt = 0L, updatedAt = 0L,
    )

    @Test
    fun signals_are_labelled_and_toned_independently() {
        assertEquals(Tone.OK, dnsSignalTone("verified"))
        assertEquals(Tone.BAD, dnsSignalTone("missing"))
        assertEquals(Tone.WARN, dnsSignalTone("pending"))
        assertEquals(Tone.OK, sslSignalTone("active"))
        assertEquals(Tone.BAD, sslSignalTone("expired"))
        assertEquals(Tone.NEUTRAL, sslSignalTone("none"))
        assertEquals(Tone.BAD, healthSignalTone("down"))
        assertEquals(Tone.OK, healthSignalTone("ok"))

        assertEquals("Not found", dnsSignalLabel("missing"))
        assertEquals("Not started", sslSignalLabel("none"))
        assertEquals("Unknown", healthSignalLabel("unknown"))
    }

    @Test
    fun a_live_domain_with_a_down_origin_keeps_the_two_tones_separate() {
        assertEquals(Tone.OK, domainStatusTone("active"))
        assertEquals(Tone.BAD, healthSignalTone("down"))
    }

    @Test
    fun dns_records_are_derived_from_the_tunnel_target_and_token() {
        assertTrue(dnsRecords(domain()).isEmpty())

        val records = dnsRecords(
            domain(
                host = "app.example.com",
                tunnelTarget = "abc.cfargotunnel.com",
                verificationToken = "mc-verify=deadbeef",
            ),
        )
        assertEquals(2, records.size)
        assertEquals(DnsRecordLine("CNAME", "app.example.com", "abc.cfargotunnel.com"), records[0])
        assertEquals(DnsRecordLine("TXT", "_mobilecloud-verify.app.example.com", "mc-verify=deadbeef"), records[1])
    }

    @Test
    fun hostname_validation_rejects_reserved_and_duplicate_hosts() {
        assertNull(hostValidationMessage("", emptyList()))
        assertEquals("That hostname is reserved and cannot be configured.", hostValidationMessage("api.internal", emptyList()))
        assertEquals("Enter a full hostname like app.example.com.", hostValidationMessage("example", emptyList()))
        assertNull(hostValidationMessage("app.example.com", emptyList()))
        assertNull(hostValidationMessage("http://app.example.com/path:8443", emptyList()))
        assertTrue(hostValidationMessage("app.example.com", listOf("APP.example.com"))!!.contains("already configured"))
    }
}
