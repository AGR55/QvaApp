package com.qvaapply.sms

import org.junit.Assert.*
import org.junit.Test

class PrecisoScreensStateTest {
    @Test fun actionStatesUseConsistentLabels() {
        assertEquals("Pendiente de confirmar",operationActionLabel("pending"))
        assertEquals("Confirmada",operationActionLabel("confirmed"))
        assertEquals("Fallida",operationActionLabel("failed"))
        listOf("Pendiente de confirmar","Confirmada","Fallida").forEach {label->
            assertEquals(label,operationActionLabel(label))
        }
        assertNull(operationActionLabel(null))
        assertNull(operationActionLabel(""))
    }

    @Test fun onlyThePendingOperationBlocksItsActions() {
        val states=mapOf("offer:one" to "Pendiente de confirmar","offer:two" to "Confirmada","other:fixed" to "Fallida")
        assertTrue(operationActionPending(states["offer:one"]))
        assertTrue(operationActionPending("pending"))
        assertFalse(operationActionPending(states["offer:two"]))
        assertFalse(operationActionPending(states["other:fixed"]))
        assertFalse(operationActionPending(states["unknown"]))
    }

    @Test fun hidingIsIdempotentAndDoesNotMutateTheSource() {
        val source=listOf("first")
        val hidden=hideAlertLocally(source,"second")
        assertEquals(listOf("first"),source)
        assertEquals(listOf("first","second"),hidden)
        assertEquals(hidden,hideAlertLocally(hidden,"second"))
        assertEquals(hidden,hideAlertLocally(hidden," "))
    }

    @Test fun undoRestoresOnlyItsBatchAndPreservesLaterDismissals() {
        val hidden=listOf("earlier","first","second","later")
        assertEquals(listOf("earlier","later"),restoreAlertsLocally(hidden,setOf("first","second")))
        assertEquals(hidden,restoreAlertsLocally(hidden,setOf("unknown")))
        assertEquals(hidden,restoreAlertsLocally(hidden,emptySet()))
        assertTrue(restoreAlertsLocally(hidden,hidden.toSet()).isEmpty())
    }

    @Test fun visibleAlertsDriveHeaderAndHomeWithoutMutatingSource() {
        val first=MobileAlert("first","operation-applied","Primero","1",null)
        val second=first.copy(id="second",message="Segundo")
        val alerts=listOf(first,second)
        val visible=visibleAlerts(alerts,setOf("first","not-in-this-page"))
        assertEquals(listOf(second),visible)
        assertEquals(1,visible.size)
        assertEquals(listOf(first,second),alerts)
        assertEquals(alerts,visibleAlerts(alerts,emptySet()))
        assertTrue(visibleAlerts(emptyList(),setOf("first")).isEmpty())
    }

    @Test fun undoRestoresTheSameVisibleSetForAllSurfaces() {
        val alerts=listOf(
            MobileAlert("first","operation-applied","Primero","1",null),
            MobileAlert("second","system-health","Segundo","2",null)
        )
        val hidden=hideAlertLocally(emptyList(),"first")
        assertEquals(listOf(alerts[1]),visibleAlerts(alerts,hidden.toSet()))
        val restored=restoreAlertsLocally(hidden,setOf("first"))
        assertEquals(alerts,visibleAlerts(alerts,restored.toSet()))
    }

    @Test fun hideCommitsOnlyAfterExitSettles() {
        assertFalse(alertHideAnimationFinished(isIdle=true,currentVisible=true,targetVisible=true))
        assertFalse(alertHideAnimationFinished(isIdle=true,currentVisible=true,targetVisible=false))
        assertFalse(alertHideAnimationFinished(isIdle=false,currentVisible=true,targetVisible=false))
        assertFalse(alertHideAnimationFinished(isIdle=false,currentVisible=false,targetVisible=false))
        assertTrue(alertHideAnimationFinished(isIdle=true,currentVisible=false,targetVisible=false))
        assertFalse(alertHideAnimationFinished(isIdle=true,currentVisible=false,targetVisible=true))
    }

    @Test fun animatingAnExitDoesNotHideTheAlertPrematurely() {
        var hidden=emptyList<String>()
        val phases=listOf(
            Triple(true,true,true),
            Triple(true,true,false),
            Triple(false,true,false),
            Triple(false,false,false)
        )
        phases.forEach {(idle,current,target)->
            if(alertHideAnimationFinished(idle,current,target)) hidden=hideAlertLocally(hidden,"first")
            assertTrue(hidden.isEmpty())
        }
        if(alertHideAnimationFinished(true,false,false)) hidden=hideAlertLocally(hidden,"first")
        assertEquals(listOf("first"),hidden)
        assertTrue(restoreAlertsLocally(hidden,setOf("first")).isEmpty())
    }
}
